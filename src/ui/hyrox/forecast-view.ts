/**
 * HYROX forecast view — sums calibrated station benchmarks + run pace and
 * applies venue-specific course factors. Mirrors the pattern of the triathlon
 * race-forecast card.
 */

import { getState, getMutableState } from '@/state/store';
import type { SimulatorState } from '@/types/state';
import { saveState } from '@/state/persistence';
import { buildRingBackground, atmosphereGradient, buildSunGlint, shouldPlayEntrance } from '@/ui/page-flair';
import { renderTabBar, wireTabBarHandlers, type TabId } from '@/ui/tab-bar';
import { buildHyroxTrademarkFooter } from './trademark-footer';
import { predictHyroxRace, type HyroxStationLine, type HyroxRunLeg, type HyroxProjectionMarkers, type HyroxPrediction, type HyroxStationProjection } from '@/calculations/race-prediction.hyrox';
import { buildHyroxProjection, hyroxForecastBandPct } from '@/calculations/race-projection.hyrox';
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
import { isInjuryActive } from '@/ui/injury/modal';
import { getDisciplineCapacity } from '@/injury/engine';
import { injuryWithResumeFallback } from '@/calculations/hyrox-injury';

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
/**
 * "Last race" retro card. Renders above the body when the most recent
 * HyroxRaceLogEntry has a `targetTotalSec` and the actual beat it by ≥60s.
 * Mirrors the tri pattern in `triathlon/forecast-view.ts:42`. HYROX has no
 * cached prediction — the "target" slot is what we compare against.
 */
function renderHyroxRaceOutcomeRetroCard(s: SimulatorState): string {
  const log = s.hyroxConfig?.raceLog;
  if (!log || log.length === 0) return '';
  const latest = log[log.length - 1];
  if (latest.targetTotalSec == null) return '';
  const gap = latest.targetTotalSec - latest.actualTotalSec;
  if (gap < 60) return '';

  const gapMin = Math.floor(gap / 60);
  const gapTxt = gapMin === 1 ? '1 min' : `${gapMin} min`;

  return `
    <div style="background:#E8F2E5;border:1px solid #B8D6AE;border-radius:14px;padding:16px;margin-bottom:14px">
      <div style="font-size:11px;font-weight:600;color:#5a8050;margin-bottom:6px">Last race</div>
      <div style="font-size:15px;font-weight:600;color:#0F172A;margin-bottom:4px">You beat your target by ${gapTxt}</div>
      <div style="font-size:12px;color:#64748B;line-height:1.5">Target ${fmtMmSs(latest.targetTotalSec)}, actual ${fmtMmSs(latest.actualTotalSec)}.</div>
    </div>
  `;
}

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
 *
 * `mode` controls row ordering:
 *  - 'race' → R1 → Station 1 → R2 → Station 2 → … (the real-race sequence)
 *  - 'station' → Station 1 … Station 8 → R1 … R8 (all stations first, runs
 *    after). Cumulative race-time values stay anchored to real race order,
 *    so a station row's "total time" still reflects when it happens in the
 *    race, not where it appears in this list.
 */
function renderRaceOrderTable(
  prediction: HyroxPrediction,
  projectedRunSec: number | undefined,
  state: SimulatorState,
  mode: 'race' | 'station' = 'race',
): string {
  const fmt = (state.hyroxConfig?.format ?? 'open_singles') as HyroxFormat;
  const legs = prediction.runLegs;
  const stations = prediction.stations;
  const stationProjByName = new Map<string, HyroxStationProjection>(
    (prediction.projection?.stations ?? []).map(p => [p.station, p]),
  );

  const runRatio = projectedRunSec && prediction.runSec > 0 ? projectedRunSec / prediction.runSec : 1;
  const showRunProjection = runRatio < 1;

  const fastestLegPace = Math.min(...legs.map(l => l.paceSecKm));
  const maxLegSlip = Math.max(...legs.map(l => l.paceSecKm - fastestLegPace));

  // Cumulative race-time at the end of each event (run or station), built once
  // in real-race order. We absorb the gap between summed-displayed-times and
  // `prediction.totalSec` (course-venue adjustment + RoxZone transitions) as a
  // uniform per-event overhead, so the last cumulative value lines up with the
  // headline projected finish. Caption explains it under the card.
  const sumDisplayed =
    legs.reduce((s, l) => s + l.paceSecKm, 0) +
    stations.reduce((s, st) => s + st.baseSec, 0);
  const overhead = prediction.totalSec - sumDisplayed;
  const perEventOverhead = overhead / (legs.length + stations.length);
  const cumByKey = new Map<string, number>();
  let cumSec = 0;
  for (let i = 0; i < legs.length; i++) {
    cumSec += legs[i].paceSecKm + perEventOverhead;
    cumByKey.set(`run-${i}`, Math.round(cumSec));
    if (i < stations.length) {
      cumSec += stations[i].baseSec + perEventOverhead;
      cumByKey.set(`station-${i}`, Math.round(cumSec));
    }
  }

  const rows: string[] = [];
  let rowIndex = 0;

  if (mode === 'race') {
    // Race order = pacing clock. Compact rows, no projection arrows, cumulative
    // "Total time" on the right so the user reads the card top-to-bottom as a
    // timeline of where they should be on the clock.
    for (let i = 0; i < legs.length; i++) {
      rows.push(renderRunLegRow(legs[i], runRatio, false, fastestLegPace, maxLegSlip, rowIndex++, cumByKey.get(`run-${i}`) ?? 0, 'race-order'));
      if (i < stations.length) {
        const line = stations[i];
        const proj = stationProjByName.get(line.station);
        rows.push(renderStationOrderRow(line, proj, state, fmt, rowIndex++, cumByKey.get(`station-${i}`) ?? 0, 'race-order'));
      }
    }
  } else {
    // Station order = where you'll gain. Per-row "now → race day" projection
    // with the gain delta on the right. No cumulative — order is no longer the
    // race sequence, so a running clock would mislead.
    for (let i = 0; i < stations.length; i++) {
      const line = stations[i];
      const proj = stationProjByName.get(line.station);
      rows.push(renderStationOrderRow(line, proj, state, fmt, rowIndex++, cumByKey.get(`station-${i}`) ?? 0, 'station-order'));
    }
    for (let i = 0; i < legs.length; i++) {
      rows.push(renderRunLegRow(legs[i], runRatio, showRunProjection, fastestLegPace, maxLegSlip, rowIndex++, cumByKey.get(`run-${i}`) ?? 0, 'station-order'));
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
  cumulativeSec: number,
  variant: 'race-order' | 'station-order',
): string {
  const projectedPace = Math.round(leg.paceSecKm * ratio);
  const slipSec = leg.paceSecKm - fastestLegPace;
  const barPct = maxLegSlip > 0 ? Math.round((slipSec / maxLegSlip) * 100) : 0;
  const pctSlipOfFastest = fastestLegPace > 0 ? (slipSec / fastestLegPace) * 100 : 0;
  const barColour = pctSlipOfFastest > 6 ? '#ef4444' : pctSlipOfFastest > 3 ? '#f59e0b' : '#7a845c';
  const projDelta = leg.paceSecKm - projectedPace;
  const showRowProjection = showProjection && projDelta >= 1;

  // Race-order variant: shared grid layout so split and total numbers line up
  // in fixed columns regardless of row type (run R# label vs. station name).
  // Bar is rendered inline with the R# label so col2 (the time-column area)
  // stays a flex spacer that never pushes the number columns.
  if (variant === 'race-order') {
    return `
      <div style="display:grid;grid-template-columns:auto 1fr 72px 60px;align-items:center;gap:12px;padding:9px 0;border-top:${rowIndex === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'};font-size:12px">
        <span style="display:flex;align-items:center;gap:10px;min-width:0">
          <span style="width:24px;color:var(--c-faint);font-weight:600;font-size:11px">R${leg.legNumber}</span>
          <div style="width:120px;max-width:30vw;height:3px;background:#F1F5F9;border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${Math.max(2, barPct)}%;background:${barColour};border-radius:2px"></div>
          </div>
        </span>
        <span></span>
        <span style="text-align:right;color:var(--c-muted);font-variant-numeric:tabular-nums;font-size:12px">${fmtPace(leg.paceSecKm)}</span>
        <span style="text-align:right;color:var(--c-black);font-variant-numeric:tabular-nums;font-size:13px;font-weight:600">${fmtMmSs(cumulativeSec)}</span>
      </div>
    `;
  }

  // Station-order variant: now → race day with race-day gain delta only. No
  // cumulative (ordering isn't race sequence), no in-race fatigue bar (that
  // signal belongs in Race order). Delta meaning is unified across this whole
  // view: every row's delta = race-day projected gain.
  const paceCell = showProjection
    ? `${fmtPace(leg.paceSecKm).replace('/km', '')} → ${fmtPace(projectedPace)}`
    : fmtPace(leg.paceSecKm);
  const deltaCell = showProjection && projDelta >= 1
    ? `−${Math.round(projDelta)}s`
    : '—';

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-top:${rowIndex === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'};font-size:13px">
      <span style="width:36px;text-align:left;color:var(--c-faint);font-weight:600;flex-shrink:0;font-size:11px">R${leg.legNumber}</span>
      <span style="flex:1"></span>
      <span style="min-width:${showProjection ? 120 : 80}px;text-align:right;color:var(--c-black);font-variant-numeric:tabular-nums;font-size:12px">${paceCell}</span>
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
  cumulativeSec: number,
  variant: 'race-order' | 'station-order',
): string {
  const display = STATION_DISPLAY[line.station];
  const sourceTag = line.source === 'calibrated' ? 'Your time' : 'Estimated';

  // currentSec anchored to baseSec (test-pace), not adjustedSec (post-venue),
  // so today's number matches the BENCHMARKS card.
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

  // Race-order variant: shared grid layout so split and total columns line up
  // with the run rows above and below. No projection arrow, no click-through —
  // drill-down lives on Station order.
  if (variant === 'race-order') {
    return `
      <div style="display:grid;grid-template-columns:auto 1fr 72px 60px;align-items:center;gap:12px;padding:11px 0;font-size:13px;border-top:${rowIndex === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'}">
        <span style="display:flex;flex-direction:column;gap:3px;min-width:0">
          <span style="color:var(--c-black)">${display.name}</span>
          <span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:10px;color:var(--c-faint)">${sourceTag}</span>
            ${prBadge}
            ${ageCaption}
          </span>
        </span>
        <span></span>
        <span style="text-align:right;color:var(--c-muted);font-variant-numeric:tabular-nums;font-size:12px">${fmtMmSs(currentSec)}</span>
        <span style="text-align:right;color:var(--c-black);font-variant-numeric:tabular-nums;font-size:13px;font-weight:600">${fmtMmSs(cumulativeSec)}</span>
      </div>
    `;
  }

  // Station-order variant: now → race day with gain delta. No cumulative.
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
      <span style="min-width:${showProjection ? 120 : 80}px;text-align:right;color:var(--c-black);font-variant-numeric:tabular-nums;font-size:12px">${timeCell}</span>
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
  return `<div style="font-size:11px;color:var(--c-faint);padding:10px 0 0;border-top:1px solid rgba(0,0,0,0.05);margin-top:8px;line-height:1.5">${sessionsLabel} for ${proj.weeksRemaining.toFixed(1)} weeks. Gain rates anchored on rowing, local muscular endurance, and HIFT adaptation literature; per-class differences applied (cardio, strength-endurance, grip-carry). Taper is gradiented (Mujika 2002): gains shrink toward race day.</div>`;
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

/**
 * Injury recovery note for the hero card.
 *
 * Mirrors the triathlon marquee's `renderInjuryRecoveryNote`
 * (race-forecast-marquee.ts:82). Reads the same `InjuryState` the HYROX injury
 * modal writes (run / upper-body / lower-body capacity + resume windows) and
 * explains, in one line, why the projected race-day gain is reduced. The
 * projection math itself is debited in `buildHyroxProjection` (run) and
 * `buildStationProjection` (stations via `stationInjuryBuildWeeks`).
 */
function naturalJoin(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function renderHyroxInjuryNote(s: SimulatorState): string {
  if (!isInjuryActive()) return '';
  // Use the same protocol-window fallback the projection uses, so the "resumes
  // in N weeks" copy matches the build-week debit driving the forecast.
  const inj = injuryWithResumeFallback(s.injuryState);
  if (!inj) return '';

  const DISCS: Array<{ key: 'run' | 'upperLoad' | 'lowerLoad'; label: string }> = [
    { key: 'run',       label: 'running'        },
    { key: 'upperLoad', label: 'upper-body work' },
    { key: 'lowerLoad', label: 'lower-body work' },
  ];

  const blocked: Array<{ label: string; weeks: number | undefined }> = [];
  const reduced: string[] = [];
  for (const d of DISCS) {
    const cap = getDisciplineCapacity(inj, d.key);
    if (cap === 0) blocked.push({ label: d.label, weeks: inj.resumeWeeksByDiscipline?.[d.key] });
    else if (cap < 100) reduced.push(d.label);
  }
  if (blocked.length === 0 && reduced.length === 0) return '';

  let body = '';
  if (blocked.length > 0) {
    const labels = naturalJoin(blocked.map(b => b.label));
    const verb = blocked.length === 1 ? 'resumes' : 'resume';
    const weeks = blocked.map(b => b.weeks).filter((w): w is number => typeof w === 'number');
    let weeksTxt = '';
    if (weeks.length > 0) {
      const lo = Math.min(...weeks);
      const hi = Math.max(...weeks);
      weeksTxt = lo === hi ? ` in ${lo} weeks` : ` in ${lo} to ${hi} weeks`;
    }
    body += `${labels} ${verb}${weeksTxt}`;
  }
  if (reduced.length > 0) {
    const labels = naturalJoin(reduced);
    const verb = reduced.length === 1 ? 'is reduced' : 'are reduced';
    body += blocked.length > 0 ? `, ${labels} ${verb} until then` : `${labels} ${verb}`;
  }
  const bodyCap = body.charAt(0).toUpperCase() + body.slice(1);

  return `
    <div style="font-size:12px;color:var(--c-muted);line-height:1.5;text-align:center;margin:12px 4px 2px;padding:0">
      Assumes recovery on schedule: ${bodyCap}. Counts each discipline only for the weeks it can train.
    </div>
  `;
}

/**
 * HYROX glass hero card — mirrors `renderForecastFingerprint` for marathon mode.
 * Big predicted finish, optional race-day delta + target-vs-goal line, and a
 * five-chip factor row (Band / Calibration / Run pace / Stations / Venue).
 * Confidence badge top-right toggles the detail panel with calibration,
 * staleness, cross-format conversion, and previous-race notes.
 */
function buildHyroxHero(
  s: SimulatorState,
  prediction: HyroxPrediction,
  hx: NonNullable<SimulatorState['hyroxConfig']>,
  venue: ReturnType<typeof getHyroxVenueById>,
): string {
  const proj = buildHyroxProjection(s, prediction);
  const rawForPct = Math.max(prediction.rawSec, 1);
  const courseFactorPct = ((prediction.totalSec - prediction.rawSec) / rawForPct) * 100;

  // Likely range — the factor-based confidence band centred on the displayed
  // forecast number. Same band-width helper feeds the projection's
  // confidenceRangeSec, so the two surfaces never disagree. Communicates "how
  // sure are we about this number" without a Monte Carlo sim.
  const bandPct = hyroxForecastBandPct(prediction.confidence, proj.weeksRemaining);
  const bandHalf = prediction.totalSec * bandPct;
  const rangeLow = Math.round(prediction.totalSec - bandHalf);
  const rangeHigh = Math.round(prediction.totalSec + bandHalf);
  const rangeLine = prediction.totalSec > 0
    ? `<div style="font-size:12px;color:var(--c-muted);margin-top:8px;font-variant-numeric:tabular-nums">Likely ${fmtMmSs(rangeLow)}–${fmtMmSs(rangeHigh)}</div>`
    : '';

  // Target delta line: "On pace vs target" / "+X min vs target" / "−X min vs target".
  // Falls back to race-day projection delta when no target is set, so the slot
  // always carries useful information.
  const target = hx.targetFinishTimeSec ?? 0;
  const delta = target > 0 ? prediction.totalSec - target : 0;
  let deltaTxt = '';
  let deltaColor = 'var(--c-muted)';
  if (target > 0) {
    if (Math.abs(delta) < 60) { deltaTxt = 'On pace vs target'; deltaColor = '#1F7A3D'; }
    else if (delta > 0)        { deltaTxt = `+${Math.round(delta / 60)} min vs target`; deltaColor = '#9A6A20'; }
    else                       { deltaTxt = `−${Math.round(-delta / 60)} min vs target`; deltaColor = '#1F7A3D'; }
  } else if (proj.weeksRemaining > 0 && Math.abs(proj.improvementSec) >= 60) {
    const min = Math.round(Math.abs(proj.improvementSec) / 60);
    deltaTxt = proj.improvementSec < 0 ? `Projected −${min} min by race day` : `Projected +${min} min by race day`;
    deltaColor = proj.improvementSec < 0 ? '#1F7A3D' : '#9A6A20';
  }

  // Five HYROX-native factor chips. Every chip navigates to its dedicated
  // factor sub-page via `renderHyroxChipDetail` (mirrors marathon mode).
  const totalStations = prediction.stations.length;
  const calibrated = prediction.calibratedCount;
  const runPaceSecKm = Math.round(prediction.runSec / 8);
  const bandLabel = hx.athleteBand ? (hx.athleteBand[0].toUpperCase() + hx.athleteBand.slice(1)) : null;
  const runPaceSourceDetail = prediction.runPaceSource === 'derived' ? 'From VDOT'
    : prediction.runPaceSource === 'seed' ? 'Population avg'
    : 'Set manually';
  const courseFactorDetail = Math.abs(courseFactorPct) < 0.1
    ? 'Course-neutral'
    : `${courseFactorPct > 0 ? '+' : '−'}${Math.abs(courseFactorPct).toFixed(1)}% vs neutral`;

  // Training chip — sessions in the current planned week + plan phase.
  const currentWk = s.wks?.[s.w ?? 0];
  const sessionsThisWeek = currentWk?.triWorkouts
    ? currentWk.triWorkouts.filter(w => w != null).length
    : 0;
  const phasePct = (s.tw && s.tw > 0) ? ((s.w ?? 0) / s.tw) : 0;
  const phaseLabel = phasePct < 0.40 ? 'Base' : phasePct < 0.75 ? 'Build' : phasePct < 0.90 ? 'Peak' : 'Taper';
  const trainingPresent = sessionsThisWeek > 0;

  type Chip = { key: string; label: string; headline: string; detail: string; present: boolean; addCta?: string };
  const chips: Chip[] = [
    { key: 'you',      label: 'You',      headline: bandLabel ?? 'Set band',         detail: hx.previousHyroxTimeSec ? fmtMmSs(hx.previousHyroxTimeSec) : '', present: !!bandLabel,    addCta: 'Set in onboarding' },
    { key: 'runpace',  label: 'Run pace', headline: fmtPace(runPaceSecKm),           detail: runPaceSourceDetail,                                           present: runPaceSecKm > 0 },
    { key: 'stations', label: 'Stations', headline: `${calibrated}/${totalStations}`, detail: `${fmtMmSs(prediction.stationsSec)} summed`,                  present: totalStations > 0, addCta: 'Test stations' },
    { key: 'training', label: 'Training', headline: `${sessionsThisWeek}/wk`,         detail: phaseLabel,                                                    present: trainingPresent,   addCta: 'Build a plan' },
    { key: 'venue',    label: 'Venue',    headline: venue?.city ?? 'Pick race',       detail: venue ? courseFactorDetail : '',                               present: !!venue,           addCta: 'Pick in onboarding' },
  ];

  const chipHtml = chips.map(c => `
    <div data-hx-chip="${c.key}" role="button" tabindex="0" style="flex:1;min-width:0;
      background:linear-gradient(135deg,rgba(255,255,255,0.62) 0%,rgba(255,255,255,0.22) 100%);
      backdrop-filter:blur(20px) saturate(170%);-webkit-backdrop-filter:blur(20px) saturate(170%);
      border:1px solid rgba(255,255,255,${c.present ? 0.55 : 0.30});
      box-shadow:0 4px 12px rgba(0,0,0,0.08),inset 0 1px 0 rgba(255,255,255,0.6);
      border-radius:14px;padding:12px 8px;text-align:center;min-height:86px;
      display:flex;flex-direction:column;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent">
      <div style="font-size:9px;color:var(--c-muted);font-weight:500;line-height:1;margin-bottom:6px">${c.label}</div>
      <div style="font-size:12px;color:${c.present ? 'var(--c-black)' : 'var(--c-muted)'};font-weight:600;line-height:1.15;letter-spacing:-0.005em;min-width:0;overflow-wrap:break-word;word-break:break-word;hyphens:auto">${c.headline}</div>
      ${c.detail ? `<div style="font-size:9px;color:var(--c-faint);line-height:1.2;margin-top:4px;min-width:0;overflow-wrap:break-word;word-break:break-word">${c.detail}</div>` : ''}
      ${!c.present && c.addCta ? `<div style="font-size:8px;color:var(--c-faint);margin-top:5px;line-height:1.15;font-style:italic">${c.addCta}</div>` : ''}
    </div>
  `).join('');

  const missing = chips.filter(c => !c.present).map(c => c.label);
  const missingLine = missing.length > 0
    ? `<div style="font-size:11px;color:var(--c-faint);margin-top:10px;line-height:1.4;text-align:center">Missing: ${missing.join(', ')}. Fewer factors mean lower confidence.</div>`
    : '';

  const confidenceLabel =
    prediction.confidence === 'high'   ? 'High confidence'   :
    prediction.confidence === 'medium' ? 'Medium confidence' :
                                          'Low confidence';
  const confidenceCaption =
    prediction.confidence === 'high'
      ? `Based on ${calibrated}/${totalStations} calibrated benchmarks${venue ? ` and venue factors` : ''}.`
    : prediction.confidence === 'medium'
      ? `${calibrated}/${totalStations} stations calibrated. Calibrate more to sharpen the prediction.`
      : `Mostly seed data. Only ${calibrated}/${totalStations} stations calibrated. Best treated as a rough benchmark.`;
  const conversionNote = prediction.crossFormatConversion === 'doubles_to_singles'
    ? `Forecast based on seed times. Your benchmarks are from a doubles race. Add singles splits to calibrate.`
    : prediction.crossFormatConversion === 'singles_to_doubles'
    ? `Forecast based on seed times. Your benchmarks are from a singles race. Add doubles splits to calibrate.`
    : '';

  // Provisional banner — surfaced prominently (not behind the confidence badge)
  // whenever the forecast rests mostly on population seed data. A user who has
  // raced but never calibrated stations, or whose only benchmarks are in the
  // other format, needs to know the number is an estimate and what to do about
  // it. Two causes, two bodies:
  //   - cross-format: their splits exist but in the wrong format (4 vs 8
  //     stations / different rest), so we use band averages for the target.
  //   - seed-dominated: few or no stations calibrated.
  // Every non-high-confidence forecast tells the user, in plain terms, that a
  // proper station assessment makes the prediction more accurate, and names the
  // protocol so they do it right (half distance, race effort). Two tiers:
  //   - low  → "Provisional forecast" (strong): cross-format or seed-dominated.
  //   - medium → "Sharpen your forecast" (soft): partially calibrated.
  const targetFormatLabel = (hx.format === 'open_doubles' || hx.format === 'pro_doubles') ? 'doubles' : 'singles';
  const calibrationProtocol = 'each station at half distance, race effort';
  const provisionalBody = prediction.crossFormatConversion === 'doubles_to_singles'
    ? `Your station times are from a doubles race, so this forecast uses population averages for singles. A singles station assessment (${calibrationProtocol}) replaces the estimates and makes the forecast accurate to you.`
    : prediction.crossFormatConversion === 'singles_to_doubles'
    ? `Your station times are from a singles race, so this forecast uses population averages for doubles. A doubles station assessment (${calibrationProtocol}) replaces the estimates and makes the forecast accurate to you.`
    : prediction.confidence === 'low'
    ? `This forecast uses population averages for your ${targetFormatLabel} stations. Log a station assessment (${calibrationProtocol}) and the forecast sharpens to your real numbers.`
    : `${calibrated} of ${totalStations} stations calibrated. Test the rest (${calibrationProtocol}) and the forecast gets more accurate with each one.`;
  // Fire for low (provisional) and medium (partially calibrated). High = silent.
  const showCalibrationBanner = prediction.confidence !== 'high';
  const bannerTitle = prediction.confidence === 'low' ? 'Provisional forecast' : 'Sharpen your forecast';
  const bannerCtaLabel = prediction.confidence === 'low' ? 'Test your stations' : 'Calibrate the rest';
  const provisionalBanner = showCalibrationBanner
    ? `
      <div style="margin-top:14px;padding:12px 14px;border-radius:12px;background:rgba(248,250,252,0.85);border:1px solid var(--c-border)">
        <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:4px">${bannerTitle}</div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.5">${provisionalBody}</div>
        <button id="hx-calibrate-banner-cta" style="margin-top:10px;padding:8px 14px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:12px;font-weight:600;color:var(--c-black);cursor:pointer">${bannerCtaLabel}</button>
      </div>
    `
    : '';
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
  const prevRaceId = hx.hyroxPreviousTimeRaceId;
  const prevTimeSec = hx.previousHyroxTimeSec;
  const prevEvent = prevRaceId ? getHyroxEventById(prevRaceId) : undefined;
  const prevVenueId = prevRaceId ? getVenueIdForEvent(prevRaceId) : undefined;
  const equivalentNote = (prevEvent && prevTimeSec && hx.venueId && prevVenueId && prevVenueId !== hx.venueId)
    ? `Your ${fmtMmSs(prevTimeSec)} from ${prevEvent.city} ≈ ${fmtMmSs(rescaleTimeAcrossVenues(prevTimeSec, prevVenueId, hx.venueId))} at ${venue?.city ?? 'this venue'}.`
    : '';
  const runPaceSourceNote = prediction.runPaceSource === 'derived'
    ? `Run pace updated from your VDOT.`
    : prediction.runPaceSource === 'seed'
    ? `Run pace estimated from population data. Add a recent run for VDOT-anchored prediction.`
    : '';

  const targetLine = hx.targetFinishTimeSec
    ? `Target ${fmtMmSs(hx.targetFinishTimeSec)} · Edit ›`
    : `Set a target finish ›`;

  const prevRaceLink = prevTimeSec != null ? (() => {
    const label = (() => {
      switch (hx.hyroxPreviousTimeFormat) {
        case 'open_singles': return 'Open Singles';
        case 'open_doubles': return 'Open Doubles';
        case 'pro_singles':  return 'Pro Singles';
        case 'pro_doubles':  return 'Pro Doubles';
        default:             return 'Format unset';
      }
    })();
    return `<button id="hx-verify-prev-format" style="margin-top:6px;padding:0;background:transparent;border:none;color:var(--c-muted);font-size:12px;cursor:pointer;text-align:center;display:block;width:100%">Previous race: ${label} · ${fmtMmSs(prevTimeSec)} · Change ›</button>`;
  })() : '';

  return `
    <div style="margin-bottom:14px">
      <div style="position:relative;background:rgba(255,255,255,0.50);backdrop-filter:blur(24px) saturate(170%);-webkit-backdrop-filter:blur(24px) saturate(170%);border-radius:24px;padding:22px 22px 20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 18px 48px rgba(0,0,0,0.10);border:1px solid rgba(255,255,255,0.55);overflow:hidden">
        <div style="position:absolute;top:14px;right:14px;z-index:2">
          <button id="hx-conf-badge" style="font-size:10px;color:var(--c-muted);background:rgba(255,255,255,0.7);border:1px solid rgba(0,0,0,0.10);border-radius:6px;padding:3px 8px;cursor:pointer">${confidenceLabel}</button>
        </div>
        <div style="position:relative;z-index:1">
          <div style="text-align:center;padding:10px 6px 14px">
            <div style="font-size:11px;font-weight:500;color:var(--c-muted)">Forecast</div>
            <div style="font-size:54px;font-weight:300;color:var(--c-black);letter-spacing:-0.03em;line-height:1;margin-top:10px;font-variant-numeric:tabular-nums">${fmtMmSs(prediction.totalSec)}</div>
            ${rangeLine}
            ${deltaTxt ? `<div style="font-size:13px;color:${deltaColor};margin-top:8px;font-weight:500">${deltaTxt}</div>` : ''}
            <button id="hx-set-target-cta" style="margin-top:10px;padding:0;background:transparent;border:none;color:var(--c-muted);font-size:12px;cursor:pointer">${targetLine}</button>
          </div>
          ${provisionalBanner}
          ${renderHyroxInjuryNote(s)}
          <div style="display:flex;gap:8px;margin-top:4px">${chipHtml}</div>
          ${missingLine}
          ${prevRaceLink}
          <div id="hx-conf-detail" style="display:none;margin-top:14px;padding:10px 12px;border-radius:10px;background:rgba(248,250,252,0.7);border:1px solid var(--c-border)">
            <div style="font-size:12px;color:var(--c-black);line-height:1.5">${confidenceCaption}</div>
            ${conversionNote ? `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">${conversionNote}</div>` : ''}
            ${stalenessNote ? `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">${stalenessNote}</div>` : ''}
            ${runPaceSourceNote ? `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">${runPaceSourceNote}</div>` : ''}
            ${equivalentNote ? `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">${equivalentNote}</div>` : ''}
            <div style="font-size:11px;color:var(--c-faint);margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.06)">Calibrated against 89,868 real HYROX finishers from Seasons 4–6.</div>
          </div>
        </div>
      </div>
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
  const firstName = (s.onboarding?.name || '').trim().split(' ')[0];
  const raceDate = hx.raceDate ?? s.onboarding?.customRaceDate;
  const raceDays = raceDate ? daysUntil(raceDate) : 0;
  const raceCountdownDisplay = raceDays > 14 ? `${Math.floor(raceDays / 7)}` : `${raceDays}`;
  const raceCountdownUnit = raceDays > 14 ? 'weeks' : 'days';

  // Title sub-line: mirrors marathon "Test's Dubai Marathon — Week 1 of 35".
  // Skips gracefully when name/event are missing.
  const eventCity = hx.raceEventId ? getHyroxEventById(hx.raceEventId)?.city : undefined;
  const currentWeek = s.w ?? 0;
  const totalWeeks = s.tw ?? 0;
  const possessive = firstName ? `${firstName}${firstName.endsWith('s') ? "'" : "'s"}` : '';
  const raceLabel = eventCity ? `${eventCity} HYROX` : 'HYROX';
  const weekLine = totalWeeks > 0 ? `Week ${currentWeek + 1} of ${totalWeeks}` : '';
  const subLineParts = [possessive ? `${possessive} ${raceLabel}` : raceLabel, weekLine].filter(Boolean);
  const subLine = subLineParts.join('. ');

  const body = !prediction
    ? `
      <div style="font-size:14px;color:var(--c-muted);line-height:1.6;background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
        Forecast not yet available. Set your previous Hyrox time or calibrate station benchmarks to get a prediction.
      </div>
    `
    : (() => {
        // Hoisted: shared between the hero (race-day projection delta) and the
        // per-leg run breakdown so both surfaces read from the same source.
        const proj = buildHyroxProjection(s, prediction);
        const projectedRunSec = proj.weeksRemaining > 0 ? proj.byDiscipline.run.projectedSec : undefined;

        return `
          ${buildHyroxHero(s, prediction, hx, venue)}

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
            const raceOrderRows = renderRaceOrderTable(prediction, projectedRunSec, s, 'race');
            const stationOrderRows = renderRaceOrderTable(prediction, projectedRunSec, s, 'station');
            return `
            <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
              <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Race order</div>
              <div style="font-size:12px;color:var(--c-muted);margin-bottom:12px;line-height:1.4">Race order shows your race-day clock at each split. Station order groups the disciplines and shows where the horizon model expects gain by race day.</div>
              <div role="tablist" style="display:flex;gap:8px;margin-bottom:12px">
                <button type="button" data-hx-order="race" role="tab" aria-selected="true" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid var(--c-black);background:var(--c-black);color:#FDFCF7;font-size:12px;font-weight:500;cursor:pointer">Race order</button>
                <button type="button" data-hx-order="station" role="tab" aria-selected="false" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid rgba(0,0,0,0.12);background:transparent;color:var(--c-muted);font-size:12px;font-weight:500;cursor:pointer">Station order</button>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-top:1px solid rgba(0,0,0,0.05);border-bottom:1px solid rgba(0,0,0,0.05);margin-bottom:2px">
                <div style="display:flex;flex-direction:column;gap:2px">
                  <span style="font-size:12px;color:var(--c-black);font-weight:500">Average run pace</span>
                  <span style="font-size:10px;color:var(--c-faint)">Across all 8 × 1km legs, post-venue</span>
                </div>
                <span style="font-size:13px;color:var(--c-black);font-variant-numeric:tabular-nums">${avgPaceCell}</span>
              </div>
              <div id="hx-rows-race">
                <div style="display:grid;grid-template-columns:auto 1fr 72px 60px;align-items:center;gap:12px;padding:8px 0 6px;font-size:10px;color:var(--c-faint)">
                  <span></span>
                  <span></span>
                  <span style="text-align:right">Split</span>
                  <span style="text-align:right">Total</span>
                </div>
                ${raceOrderRows}
              </div>
              <div id="hx-rows-station" style="display:none">${stationOrderRows}</div>
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

  // Ring entrance + drift play on the first Forecast visit per session only.
  const animate = shouldPlayEntrance('hyrox-forecast');

  root.innerHTML = `
    <div class="mosaic-page" style="min-height:100vh;background:${atmosphereGradient('sky')};position:relative;overflow:hidden">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxf', { variant: 'sweep', palette: 'sky', pulse: animate, entrance: animate ? 'small' : 'none' })}
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
        <div style="text-align:center;padding:4px 4px 18px">
          <div style="font-size:32px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;line-height:1">HYROX forecast</div>
          ${subLine ? `<div style="font-size:13px;color:var(--c-muted);margin-top:6px;font-weight:500">${subLine}</div>` : ''}
        </div>
        ${renderHyroxRaceOutcomeRetroCard(s)}
        ${body}
        <div style="padding:10px 0 4px;text-align:center">
          <button id="hx-methodology-btn" type="button" style="font:inherit;font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0">How this is calculated →</button>
        </div>
        ${buildHyroxTrademarkFooter()}
      </div>
    </div>
  `;

  // Account button → navigate to account view.
  document.getElementById('hx-forecast-account-btn')?.addEventListener('click', () => {
    import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
  });

  document.getElementById('hx-methodology-btn')?.addEventListener('click', () => {
    import('@/ui/methodology-view').then(({ renderMethodologyHyrox }) =>
      renderMethodologyHyrox(() => renderHyroxForecastView()));
  });

  // Confidence badge: toggle the explanation panel.
  document.getElementById('hx-conf-badge')?.addEventListener('click', () => {
    const detail = document.getElementById('hx-conf-detail');
    if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
  });

  // Provisional-banner CTA → stations factor page (carries the "Test stations"
  // calibration entry point). Same destination as the Stations hero chip.
  document.getElementById('hx-calibrate-banner-cta')?.addEventListener('click', () => {
    import('./forecast-chip-detail-view').then(({ renderHyroxChipDetail }) =>
      renderHyroxChipDetail('stations'));
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

  // Race-order ↔ station-order segment control: swap visible row container.
  // Both row sets are pre-rendered (cheap), so the toggle is instant.
  document.querySelectorAll<HTMLButtonElement>('[data-hx-order]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-hx-order') as 'race' | 'station' | null;
      if (!mode) return;
      const raceEl = document.getElementById('hx-rows-race');
      const stationEl = document.getElementById('hx-rows-station');
      if (!raceEl || !stationEl) return;
      raceEl.style.display = mode === 'race' ? '' : 'none';
      stationEl.style.display = mode === 'station' ? '' : 'none';
      document.querySelectorAll<HTMLButtonElement>('[data-hx-order]').forEach(b => {
        const isActive = b === btn;
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        b.style.background = isActive ? 'var(--c-black)' : 'transparent';
        b.style.color = isActive ? '#FDFCF7' : 'var(--c-muted)';
        b.style.borderColor = isActive ? 'var(--c-black)' : 'rgba(0,0,0,0.12)';
      });
    });
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

  // Calibrate CTA — wires the performance radar's "Calibrate" prompt to the
  // plan view, un-dismissing the benchmark card so the user lands on a working
  // entry point. (The legacy "Sharpen this forecast" card was removed when the
  // hero adopted the marathon factor-chip pattern; the Calibration chip in the
  // hero now signals the same status passively.)
  document.getElementById('hx-radar-calibrate-cta')?.addEventListener('click', () => {
    const ms = getMutableState();
    if (ms.hyroxConfig && (ms.hyroxConfig as { dismissedBenchmarkCard?: boolean }).dismissedBenchmarkCard) {
      (ms.hyroxConfig as { dismissedBenchmarkCard?: boolean }).dismissedBenchmarkCard = false;
      saveState();
    }
    import('@/ui/hyrox/plan-view').then(({ renderHyroxPlanView }) => renderHyroxPlanView());
  });

  // Hero chip drill-downs — every chip navigates to its dedicated full-page
  // factor view (mirrors marathon mode). Stations + Venue pages carry their
  // own action CTAs (Test stations / Pick race).
  document.querySelectorAll<HTMLElement>('[data-hx-chip]').forEach(el => {
    const open = () => {
      const key = el.getAttribute('data-hx-chip') as
        | 'you' | 'runpace' | 'stations' | 'training' | 'venue' | null;
      if (!key) return;
      import('./forecast-chip-detail-view').then(({ renderHyroxChipDetail }) =>
        renderHyroxChipDetail(key));
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });

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
        <button id="hx-prev-fmt-cancel" class="m-btn-secondary" style="flex:1;padding:11px;font-size:13px">Cancel</button>
        <button id="hx-prev-fmt-save" class="m-btn-primary" style="flex:1;padding:11px;font-size:13px;opacity:0.5" disabled>Save</button>
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
