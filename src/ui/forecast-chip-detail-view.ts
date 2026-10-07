/**
 * Forecast-fingerprint chip detail pages.
 *
 * Tapping a cluster chip (You / Capacity / Response / Training / Venue) on
 * the marathon-forecast hero navigates to a full-page detail view. Each
 * page leads with a chart or visual breakdown, then a short caption,
 * then the key numbers. Visual first, not prose. Back button returns to
 * the forecast view.
 *
 * Mirrors the canonical detail-page chrome from `race-readiness-detail.ts`
 * (sky atmosphere, sun glint, back button, tab bar).
 */

import { raceDayEnduranceGapText } from '@/calculations/race-day-durability';
import { getState } from '@/state/store';
import type { SimulatorState } from '@/types/state';
import { ft, fp, formatKm } from '@/utils/format';
import { cv, rdKm } from '@/calculations/vdot';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { atmosphereGradient, buildSunGlint, buildRingBackground } from './page-flair';
import { buildBenchmarkTrendChart, smoothAreaPath } from './triathlon/benchmark-charts';
import { RUNNING_FACTOR_SOURCES } from '@/constants/triathlon-course-factors';
import {
  computeSportMix as computeSportMixShared,
  collapseTopN,
  buildSportDonut as buildSportDonutShared,
  buildSportLegend as buildSportLegendShared,
} from './sport-mix-donut';
import {
  VENUE_DATA_PROVENANCE,
  VENUE_PERCENTILE_TABLES,
} from '@/data/marathon-population-distributions';
import {
  predictFromPB,
  predictFromRecent,
  predictFromLT,
  predictFromVO2,
  predictFromHR,
  predictFromVolume,
} from '@/calculations/predictions';
import { collectRunsFromState } from '@/calculations/blended-fitness';
import { computePredictionInputs } from '@/calculations/prediction-inputs';
import { buildInfoIcon, mountInfoPopovers } from './info-popover';

export type ChipKey = 'you' | 'capacity' | 'response' | 'training' | 'venue' | 'durability' | 'heat' | 'calibration' | 'shoes';

// ── Design tokens (mirror race-readiness-detail / race-forecast-view) ────────

const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const TEXT_L = '#94A3B8';
const CARD = 'background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px 20px';

// ── Shared helpers ───────────────────────────────────────────────────────────

function escapeText(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function statRow(label: string, value: string): string {
  return `
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.04)">
      <span style="color:${TEXT_S}">${escapeText(label)}</span>
      <span style="color:${TEXT_M};font-variant-numeric:tabular-nums">${escapeText(value)}</span>
    </div>
  `;
}

function captionCard(text: string): string {
  return `
    <div style="padding:0 4px;font-size:13px;color:${TEXT_S};line-height:1.55;margin-top:14px">
      ${text}
    </div>
  `;
}

function emptyStateCard(line: string, cta: string): string {
  return `
    <div style="${CARD};text-align:center">
      <div style="font-size:14px;color:${TEXT_M};line-height:1.5;margin-bottom:6px">${escapeText(line)}</div>
      <div style="font-size:12px;color:${TEXT_S}">${escapeText(cta)}</div>
    </div>
  `;
}

// ── Per-chip page bodies ─────────────────────────────────────────────────────

const SPORT_MIX_TOKENS = { textM: TEXT_M, textS: TEXT_S, textL: TEXT_L, accent: '#3B82F6' };
const computeSportMix = computeSportMixShared;
const buildSportDonut = (slices: Parameters<typeof buildSportDonutShared>[0], totalWeeklyTSS: number) =>
  buildSportDonutShared(slices, totalWeeklyTSS, SPORT_MIX_TOKENS);
const buildSportLegend = (slices: Parameters<typeof buildSportLegendShared>[0]) =>
  buildSportLegendShared(slices, SPORT_MIX_TOKENS);

function pageYou(s: SimulatorState): { title: string; subhead: string; body: string } {
  const typ = s.typ ?? 'Balanced';
  const tier = s.athleteTier;
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1).replace('_', '-') : 'Not classified';
  const ctl = Math.round(s.ctlBaseline ?? 0);
  const age = s.onboarding?.age;
  const unitPref = s.unitPref ?? 'km';

  const pbs = s.pbs ?? {};
  const pbEntries: Array<[string, number | undefined]> = [
    ['5K', pbs.k5], ['10K', pbs.k10], ['Half marathon', pbs.h], ['Marathon', pbs.m],
  ];
  const pbsWithValues = pbEntries.filter(([, v]) => typeof v === 'number' && v > 0) as Array<[string, number]>;
  const raceLog = s.runRaceLog ?? [];
  const raceCount = raceLog.length;

  const { slices: rawSlices, totalWeeklyTSS } = computeSportMix(s);
  const slices = collapseTopN(rawSlices, 3);
  const totalSessionsPerWeek = rawSlices.reduce((sum, slice) => sum + slice.sessionsPerWeek, 0);
  const weeklyKm = s.detectedWeeklyKm ?? 0;

  const metaParts: string[] = [`${escapeText(tierLabel)} tier`];
  if (ctl > 0) metaParts.push(`CTL ${ctl}`);
  if (typeof age === 'number' && age > 0) metaParts.push(`age ${age}`);
  const profileMeta = metaParts.join(' · ');

  const profileCard = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:14px;color:${TEXT_S};font-weight:500">Runner profile</span>
        <span style="font-size:12px;color:${TEXT_L}">Anchors the model</span>
      </div>
      <div style="font-size:26px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em;margin-bottom:6px">${escapeText(typ)}</div>
      <div style="font-size:13px;color:${TEXT_S}">${profileMeta}</div>
    </div>
  `;

  const sportMixCard = slices.length > 0 ? `
    <div style="${CARD};margin-bottom:14px;overflow:hidden;position:relative">
      <div style="position:relative">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="font-size:14px;color:${TEXT_S};font-weight:500">Training mix</span>
          <span style="font-size:11px;color:${TEXT_L}">8-week Strava history</span>
        </div>
        ${buildSportDonut(slices, totalWeeklyTSS)}
        ${buildSportLegend(slices)}
      </div>
    </div>
  ` : '';

  const volumeCard = (weeklyKm > 0 || totalSessionsPerWeek > 0 || totalWeeklyTSS > 0) ? `
    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:6px">Recent volume</div>
      ${weeklyKm > 0 ? statRow('Running', `${formatKm(weeklyKm, unitPref, 0)}/wk`) : ''}
      ${totalSessionsPerWeek > 0 ? statRow('All sports', `${totalSessionsPerWeek.toFixed(1).replace(/\.0$/, '')} sessions/wk`) : ''}
      ${totalWeeklyTSS > 0 ? statRow('Weekly load', `${Math.round(totalWeeklyTSS)} TSS`) : ''}
    </div>
  ` : '';

  const pbRows = pbsWithValues.length === 0
    ? `<div style="font-size:13px;color:${TEXT_S};line-height:1.5;text-align:center;padding:6px 0">No personal bests on file yet. Import your run history to anchor the prediction.</div>`
    : pbsWithValues.map(([dist, sec]) => statRow(dist, ft(sec))).join('');
  const pbsCard = `
    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:10px">Personal bests</div>
      ${pbRows}
      <button id="fcd-import-runs" style="display:block;width:100%;margin-top:12px;padding:11px 14px;border-radius:100px;border:1px solid var(--c-border);background:transparent;color:${TEXT_M};font:inherit;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">${pbsWithValues.length === 0 ? 'Import run history' : 'Import more runs'} →</button>
    </div>
  `;

  const racesCard = raceCount > 0 ? (() => {
    const recent = raceLog.slice(-3).reverse();
    return `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
          <span style="font-size:14px;color:${TEXT_S};font-weight:500">Race history</span>
          <span style="font-size:11px;color:${TEXT_L}">${raceCount} logged</span>
        </div>
        ${recent.map(r => {
          const gap = r.predictedTotalSec - r.actualTotalSec;
          const gapTxt = Math.abs(gap) < 60 ? 'on prediction' : (gap > 0 ? `beat by ${Math.round(gap / 60)} min` : `behind by ${Math.round(-gap / 60)} min`);
          const tone = Math.abs(gap) < 60 ? TEXT_S : (gap > 0 ? '#1F7A3D' : '#9A6A20');
          return `
            <div style="padding:9px 0;border-top:1px solid rgba(0,0,0,0.04);font-size:13px">
              <div style="display:flex;justify-content:space-between;align-items:baseline">
                <span style="color:${TEXT_M}">${escapeText(r.distance === '5k' ? '5K' : r.distance === '10k' ? '10K' : r.distance === 'half' ? 'Half marathon' : r.distance === 'marathon' ? 'Marathon' : 'Race')}</span>
                <span style="color:${TEXT_M};font-variant-numeric:tabular-nums">${ft(r.actualTotalSec)}</span>
              </div>
              <div style="font-size:11px;color:${tone};margin-top:2px">${escapeText(gapTxt)}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  })() : '';

  const body = `
    ${profileCard}
    ${sportMixCard}
    ${volumeCard}
    ${pbsCard}
    ${racesCard}
    ${captionCard(`Runner type shapes how aggressively the plan progresses. ${escapeText(tierLabel)} tier is derived from your training-load baseline (${ctl > 0 ? `CTL ${ctl}` : 'CTL pending'}). PBs anchor the prediction to known race performance. Recent ones carry more weight than years-old times. The training mix shows where your weekly load comes from across all sports.`)}
  `;

  return { title: 'You', subhead: 'Profile that anchors the prediction', body };
}

// ── Blend predictor breakdown ────────────────────────────────────────────────
//
// Mirrors the weight table inside `blendPredictions()` (predictions.ts:550)
// so we can show users which predictors fed their forecast and at what weight.
// Recomputes each predictor's output via the exported `predictFrom*` functions;
// does NOT re-run the redistribution logic exactly, so the displayed weights
// are the *base* weights before HR-confidence and Tanda-gating reshuffles.
// That trade-off keeps the UI code stable when the engine's redistribution
// rules evolve.

interface BlendPredictorRow {
  key: string;
  label: string;
  description: string;
  baseWeightPct: number;
  outputSec: number | null;
  fired: boolean;
  reason: string;
}

const TARGET_DIST_M: Record<string, number> = {
  '5k': 5000,
  '10k': 10000,
  'half': 21097,
  'marathon': 42195,
};

function buildBlendBreakdown(s: SimulatorState): { targetDistM: number; rows: BlendPredictorRow[] } | null {
  const targetDistM = TARGET_DIST_M[(s.rd ?? 'marathon') as string];
  if (!targetDistM) return null;

  // Mirror refreshBlendedFitness (blended-fitness.ts:138-145): derive the most
  // recent qualifying run from garminActuals and fall back to s.rec only if
  // no derived run exists. Without this, the drill-down read "no signal" while
  // the live blend was happily firing on activity-derived recent runs.
  const runs = collectRunsFromState(s);
  const blendInputs = computePredictionInputs(runs);
  const recentRun = blendInputs.recentRun ?? s.rec ?? null;
  const recentIsDerived = blendInputs.recentRun != null;
  const hasRecent = !!(recentRun && recentRun.t && recentRun.t > 0);
  const isMarathon = targetDistM === 42195;

  // Base weights from blendPredictions (predictions.ts:551-565). Two variants:
  // with vs without a recent race log. Tanda only appears at marathon.
  let pb: number, lt: number, vo2: number, hr: number, recent: number, tanda: number;
  if (hasRecent) {
    if (targetDistM === 5000)       ({ pb, lt, vo2, hr, recent, tanda } = { pb: 0.10, lt: 0.30, vo2: 0.20, hr: 0.15, recent: 0.25, tanda: 0 });
    else if (targetDistM === 10000) ({ pb, lt, vo2, hr, recent, tanda } = { pb: 0.10, lt: 0.35, vo2: 0.15, hr: 0.15, recent: 0.25, tanda: 0 });
    else if (targetDistM === 21097) ({ pb, lt, vo2, hr, recent, tanda } = { pb: 0.10, lt: 0.40, vo2: 0.10, hr: 0.15, recent: 0.25, tanda: 0 });
    else                            ({ pb, lt, vo2, hr, recent, tanda } = { pb: 0.05, lt: 0.30, vo2: 0.10, hr: 0.10, recent: 0.15, tanda: 0.30 });
  } else {
    if (targetDistM === 5000)       ({ pb, lt, vo2, hr, recent, tanda } = { pb: 0.20, lt: 0.35, vo2: 0.30, hr: 0.15, recent: 0,    tanda: 0 });
    else if (targetDistM === 10000) ({ pb, lt, vo2, hr, recent, tanda } = { pb: 0.20, lt: 0.40, vo2: 0.25, hr: 0.15, recent: 0,    tanda: 0 });
    else if (targetDistM === 21097) ({ pb, lt, vo2, hr, recent, tanda } = { pb: 0.15, lt: 0.50, vo2: 0.20, hr: 0.15, recent: 0,    tanda: 0 });
    else                            ({ pb, lt, vo2, hr, recent, tanda } = { pb: 0.10, lt: 0.40, vo2: 0.10, hr: 0.10, recent: 0,    tanda: 0.30 });
  }

  // Each predictor's output (sec at target distance), independent of weight.
  const runnerType = (s.typ ?? 'Balanced').toLowerCase();
  const b = s.b ?? 1.10;

  const tPB = predictFromPB(targetDistM, s.pbs ?? {}, b);
  const tRecent = hasRecent ? predictFromRecent(targetDistM, recentRun, s.pbs ?? {}, b) : null;
  const tLT = s.lt && s.lt > 0 ? predictFromLT(targetDistM, s.lt, runnerType, s.athleteTier) : null;
  const tVO2 = s.vo2 && s.vo2 > 0 ? predictFromVO2(targetDistM, s.vo2) : null;
  // `state.hrCalibratedVdot` is a narrower copy missing `paceAtVO2max`; the
  // predictFromHR function only reads `.vdot`, so the cast is safe.
  const tHR = (s.hrCalibratedVdot && s.hrCalibratedVdot.vdot != null && s.hrCalibratedVdot.confidence !== 'none')
    ? predictFromHR(targetDistM, { ...s.hrCalibratedVdot, paceAtVO2max: null } as Parameters<typeof predictFromHR>[1])
    : null;

  // Tanda: needs ≥ 4w history + medium+ pace confidence + non-stale; marathon only.
  let tTanda: number | null = null;
  let tandaReason = isMarathon ? 'Needs ≥4 weeks of training + medium pace confidence' : 'Marathon-only predictor';
  if (isMarathon) {
    const trusted = blendInputs.weeksCovered >= 4
      && (blendInputs.paceConfidence === 'high' || blendInputs.paceConfidence === 'medium')
      && !blendInputs.isStale;
    if (trusted) {
      tTanda = predictFromVolume(targetDistM, blendInputs.weeklyKm, blendInputs.avgPaceSecPerKm ?? undefined);
      if (tTanda != null) tandaReason = `Fired on ${blendInputs.weeksCovered}w history, ${blendInputs.paceConfidence} pace confidence`;
      else tandaReason = 'Inputs out of range';
    } else {
      const why: string[] = [];
      if (blendInputs.weeksCovered < 4) why.push(`${blendInputs.weeksCovered}w (need 4w)`);
      if (blendInputs.paceConfidence !== 'high' && blendInputs.paceConfidence !== 'medium') why.push(`${blendInputs.paceConfidence} pace confidence`);
      if (blendInputs.isStale) why.push('stale data');
      tandaReason = `Gated: ${why.join(' · ')}`;
    }
  }

  const rows: BlendPredictorRow[] = [
    { key: 'pb',     label: 'Personal best',  description: 'Fatigue-exponent extrapolation from closest PB', baseWeightPct: pb * 100,     outputSec: tPB,     fired: tPB != null,     reason: tPB != null ? 'PB on file' : 'No PB at relevant distance' },
    { key: 'recent', label: 'Recent run',     description: 'Time-decayed weight from latest race or TT',     baseWeightPct: recent * 100, outputSec: tRecent, fired: tRecent != null, reason: hasRecent ? `${recentRun!.weeksAgo ?? '—'}w ago${recentIsDerived ? ' (from latest activity)' : ''}` : 'No recent race/TT logged' },
    { key: 'lt',    label: 'Lactate threshold', description: 'LT pace scaled by runner type and tier',       baseWeightPct: lt * 100,     outputSec: tLT,     fired: tLT != null,     reason: tLT != null ? `LT ${formatLtPace(s.lt!, s.unitPref ?? 'km')}` : 'No LT pace yet' },
    { key: 'vo2',   label: 'VO2max',         description: 'Daniels VDOT inversion',                          baseWeightPct: vo2 * 100,    outputSec: tVO2,    fired: tVO2 != null,    reason: tVO2 != null ? `VDOT ${s.vo2!.toFixed(1)}` : 'No VO2max signal' },
    { key: 'hr',    label: 'HR-calibrated',  description: 'Swain regression on HR-tagged runs (8w)',         baseWeightPct: hr * 100,     outputSec: tHR,     fired: tHR != null,     reason: tHR != null ? `${s.hrCalibratedVdot!.confidence ?? 'medium'} confidence (n=${s.hrCalibratedVdot!.n ?? 0})` : 'No HR-tagged runs yet' },
  ];
  if (tanda > 0) {
    rows.push({ key: 'tanda', label: 'Volume + pace (Tanda)', description: 'Outcome-calibrated marathon model (r=0.91)', baseWeightPct: tanda * 100, outputSec: tTanda, fired: tTanda != null, reason: tandaReason });
  }

  return { targetDistM, rows };
}

function formatLtPace(secPerKm: number, unitPref: string): string {
  const sec = unitPref === 'mi' ? secPerKm * 1.60934 : secPerKm;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}${unitPref === 'mi' ? '/mi' : '/km'}`;
}

function renderBlendCard(s: SimulatorState): string {
  const breakdown = buildBlendBreakdown(s);
  if (!breakdown) return '';
  const { rows } = breakdown;
  const firedCount = rows.filter(r => r.fired).length;
  const distLabel = s.rd === '5k' ? '5K' : s.rd === '10k' ? '10K' : s.rd === 'half' ? 'Half marathon' : 'Marathon';

  const rowsHtml = rows.map(r => {
    const tone = !r.fired ? TEXT_L : r.outputSec != null ? TEXT_M : TEXT_S;
    const valueDisplay = r.fired && r.outputSec != null
      ? `<span style="font-variant-numeric:tabular-nums;color:${TEXT_M};font-weight:600">${ft(r.outputSec)}</span>`
      : `<span style="color:${TEXT_L};font-style:italic;font-size:12px">no signal</span>`;
    return `
      <div style="padding:12px 0;border-top:1px solid rgba(0,0,0,0.04)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
          <span style="font-size:13px;color:${tone};font-weight:500">${escapeText(r.label)} <span style="color:${TEXT_L};font-size:11px;font-weight:400">(${r.baseWeightPct.toFixed(0)}%)</span></span>
          ${valueDisplay}
        </div>
        <div style="font-size:11px;color:${TEXT_L};line-height:1.4">${escapeText(r.description)} · ${escapeText(r.reason)}</div>
      </div>
    `;
  }).join('');

  return `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:14px;color:${TEXT_S};font-weight:500">Blend predictors</span>
        <span style="font-size:11px;color:${TEXT_L}">${firedCount} of ${rows.length} firing · ${distLabel} target</span>
      </div>
      ${rowsHtml}
    </div>
  `;
}

function pageCapacity(s: SimulatorState): { title: string; subhead: string; body: string } {
  const currentVdot = s.blendedEffectiveVdot ?? s.v ?? 0;
  // Projected race-day VDOT, inferred from the forecast race time at the
  // selected race distance. Same conversion the predictor uses; falls back
  // to current when no forecast exists.
  const forecastTime = s.forecastTime ?? s.forecastTimeAdjusted ?? 0;
  const raceKm = s.rd ? rdKm(s.rd) : 0;
  const projectedVdot = forecastTime > 0 && raceKm > 0
    ? cv(raceKm * 1000, forecastTime)
    : null;
  const lt = s.lt;
  const unitPref = s.unitPref ?? 'km';

  // Weeks remaining to race day. `tw` = total weeks, `w` = current week.
  const totalWeeks = s.tw ?? (s.wks?.length ?? 0);
  const currentWeek = s.w ?? 1;
  const weeksRemaining = Math.max(0, totalWeeks - currentWeek);

  // ── Fitness markers card (current → projected race-day) ─────────────────
  const markerRow = (
    label: string,
    accent: string,
    current: number | null,
    projected: number | null,
    fmt: (v: number) => string,
    inverted: boolean,
  ): string => {
    if (current == null || current <= 0) {
      return `
        <div style="padding:12px 0;border-top:1px solid rgba(0,0,0,0.04)">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="display:flex;align-items:center;gap:8px;font-size:13px;color:${TEXT_M};font-weight:500">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${accent}"></span>
              ${escapeText(label)}
            </span>
            <span style="font-size:11px;color:${TEXT_L}">No marker yet</span>
          </div>
        </div>
      `;
    }
    const minDelta = label === 'VDOT' ? 0.5 : 1;
    const moved = projected != null && Math.abs(current - projected) >= minDelta;
    const improving = projected != null
      ? (inverted ? projected < current : projected > current)
      : false;
    const deltaTone = !moved ? TEXT_S : (improving ? '#1F7A3D' : '#9A6A20');
    return `
      <div style="padding:12px 0;border-top:1px solid rgba(0,0,0,0.04)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="display:flex;align-items:center;gap:8px;font-size:13px;color:${TEXT_M};font-weight:500">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${accent}"></span>
            ${escapeText(label)}
          </span>
          <span style="font-size:13px;color:${TEXT_M};font-variant-numeric:tabular-nums">${fmt(current)}${moved ? ` → <span style="color:${deltaTone}">${fmt(projected!)}</span>` : ''}</span>
        </div>
        <div style="font-size:11px;color:${TEXT_L}">${moved ? (improving ? 'Projected race-day gain' : 'Detraining if plan slips') : 'Projection ≈ current'}</div>
      </div>
    `;
  };

  const markersCard = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:14px;color:${TEXT_S};font-weight:500">Fitness markers</span>
        <span style="font-size:11px;color:${TEXT_L}">${weeksRemaining > 0 ? `${weeksRemaining}w to race day` : 'Race date pending'}</span>
      </div>
      ${markerRow('VDOT', '#16A34A', currentVdot, projectedVdot, (v) => v.toFixed(1), /*inverted*/ false)}
      ${lt && lt > 0 ? markerRow('LT pace', '#14B8A6', lt, null, (v) => fp(v, unitPref), /*inverted*/ true) : ''}
    </div>
  `;

  // ── VDOT history sparkline ───────────────────────────────────────────────
  const vdotSamples = (s.vdotHistory ?? [])
    .filter(h => h.vdot && h.vdot > 0 && h.date)
    .map(h => ({ date: h.date!, value: h.vdot }));

  const sparkVdot = vdotSamples.length >= 2 ? `
    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:13px;color:${TEXT_S};font-weight:500;margin-bottom:10px">VDOT history</div>
      ${buildBenchmarkTrendChart(vdotSamples, '#16A34A', 'rgba(22,163,74,0.10)', '', /*inverted*/ false)}
    </div>
  ` : '';

  const body = `
    ${markersCard}
    ${sparkVdot}
    ${captionCard('VDOT is the model\'s single-number proxy for aerobic capacity. The current value is a weighted blend of up to six predictors (race PBs, recent runs, LT pace, HR-calibrated efforts, Tanda formula). The projected race-day VDOT is derived from your forecast finish time at the race distance — it factors in weeks remaining, planned sessions, and recent adherence. Markers without recent training get demoted so the projection does not overpromise gains.')}
  `;

  return { title: 'Capacity', subhead: 'Fitness markers that set the pace floor', body };
}

// ── Prediction-penalty surface (pageResponse) ────────────────────────────────
//
// The blend can fire up to three discount/penalty paths that slow the forecast
// down. Surfacing them here is honest: when the user's number feels
// conservative they should see why, not have to guess. Mirrors the gate logic
// in predictions.ts (search for `marathonSpecificityPenalty`,
// `noLongRacePenalty`, `lowVolumeDiscount`).

interface PenaltyRow {
  label: string;
  status: 'active' | 'inactive' | 'na';
  detail: string;
  effect: string;
}

function buildPenalties(s: SimulatorState): PenaltyRow[] {
  const rows: PenaltyRow[] = [];
  const distM = TARGET_DIST_M[(s.rd ?? 'marathon') as string] ?? 42195;
  const isMarathon = distM === 42195;

  // Tanda eligibility (drives marathon-specificity gate)
  const runs = isMarathon ? collectRunsFromState(s) : [];
  const inputs = isMarathon ? computePredictionInputs(runs) : null;
  const tandaTrusted = inputs
    ? inputs.weeksCovered >= 4
      && (inputs.paceConfidence === 'high' || inputs.paceConfidence === 'medium')
      && !inputs.isStale
    : false;
  const weeklyKm = inputs?.weeklyKm ?? s.detectedWeeklyKm ?? 0;

  // 1. Marathon specificity penalty (predictions.ts ~703).
  if (isMarathon) {
    const active = !tandaTrusted && weeklyKm < 30 && weeklyKm > 0;
    rows.push({
      label: 'Marathon specificity',
      status: active ? 'active' : 'inactive',
      detail: active
        ? `Volume ${weeklyKm.toFixed(0)} km/wk is below the 30 km/wk threshold and Tanda is gated.`
        : tandaTrusted ? 'Suppressed. Tanda covers volume sensitivity directly.'
        : weeklyKm >= 30 ? 'Volume above 30 km/wk threshold.'
        : 'Suppressed. No usable weekly km yet.',
      effect: active ? 'Slows the marathon forecast by 5–15% (recency-adjusted for marathon PB age).' : 'No effect on the forecast.',
    });
  }

  // 2. No-long-race penalty (predictions.ts ~760).
  // Only surface the row when actionable. Once a long-race PB is on file the
  // gate is permanently closed for that PB, so the row is noise. Hide it.
  if (isMarathon) {
    const hasLongPb = (s.pbs?.h ?? 0) > 0 || (s.pbs?.m ?? 0) > 0;
    const active = !hasLongPb && !tandaTrusted;
    if (!hasLongPb) {
      rows.push({
        label: 'Long-race PB cold-start',
        status: active ? 'active' : 'inactive',
        detail: active
          ? 'No half or full marathon PB on file and Tanda is gated.'
          : 'Suppressed. Tanda is firing.',
        effect: active ? 'Cold-start penalty: +1–2% on the prediction (runner-type dependent).' : 'No effect on the forecast.',
      });
    }
  }

  // 3. Low-volume LT/VO2 discount (non-marathon distances only).
  if (!isMarathon) {
    const lowVol = (s.detectedWeeklyKm ?? 0) < 30 && (s.detectedWeeklyKm ?? 0) > 0;
    rows.push({
      label: 'Low-volume LT/VO2 discount',
      status: lowVol ? 'active' : 'inactive',
      detail: lowVol
        ? `Volume ${(s.detectedWeeklyKm ?? 0).toFixed(0)} km/wk shifts weight away from LT and VO2.`
        : (s.detectedWeeklyKm ?? 0) >= 30 ? 'Volume above 30 km/wk threshold.'
        : 'Suppressed. No usable weekly km yet.',
      effect: lowVol ? 'LT and VO2 weights shift toward PB-derived prediction.' : 'No effect on the forecast.',
    });
  }

  return rows;
}

function renderPenaltiesCard(s: SimulatorState): string {
  const rows = buildPenalties(s);
  if (rows.length === 0) return '';
  const activeCount = rows.filter(r => r.status === 'active').length;

  const rowsHtml = rows.map(r => {
    const isActive = r.status === 'active';
    const dot = isActive
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#C48A3A"></span>`
      : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:rgba(15,23,42,0.15)"></span>`;
    return `
      <div style="padding:12px 0;border-top:1px solid rgba(0,0,0,0.04)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="display:flex;align-items:center;gap:8px;font-size:13px;color:${isActive ? TEXT_M : TEXT_S};font-weight:500">
            ${dot}${escapeText(r.label)}
          </span>
          <span style="font-size:11px;color:${isActive ? '#9A6A20' : TEXT_L};font-weight:${isActive ? 600 : 400}">${isActive ? 'active' : 'inactive'}</span>
        </div>
        <div style="font-size:11px;color:${TEXT_S};line-height:1.4">${escapeText(r.detail)}</div>
        <div style="font-size:11px;color:${TEXT_L};line-height:1.4;margin-top:2px;font-style:italic">${escapeText(r.effect)}</div>
      </div>
    `;
  }).join('');

  return `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:14px;color:${TEXT_S};font-weight:500">Active penalties</span>
        <span style="font-size:11px;color:${TEXT_L}">${activeCount} of ${rows.length} firing</span>
      </div>
      ${rowsHtml}
    </div>
  `;
}

function pageResponse(s: SimulatorState): { title: string; subhead: string; body: string } {
  const adaptation = s.adaptationRatio;
  const history = (s.vdotHistory ?? []).filter(h => h.vdot && h.vdot > 0);
  const sampleCount = history.length;
  const first = history[0];
  const last = history[history.length - 1];
  const delta = first && last ? last.vdot - first.vdot : 0;
  const tFirst = first?.date ? Date.parse(first.date) : NaN;
  const tLast = last?.date ? Date.parse(last.date) : NaN;
  const windowDays = first && last
    ? (Number.isFinite(tFirst) && Number.isFinite(tLast)
        ? Math.max(1, Math.round((tLast - tFirst) / 86_400_000))
        : Math.max(1, last.week - first.week) * 7)
    : 0;

  const vdotSamples = history
    .filter(h => h.date)
    .map(h => ({ date: h.date!, value: h.vdot }));

  let headline: string;
  let trajectoryTone: 'up' | 'down' | 'flat' | 'thin';
  if (sampleCount < 4) {
    headline = 'Building signal';
    trajectoryTone = 'thin';
  } else if (delta > 0.4) {
    headline = 'Trending up';
    trajectoryTone = 'up';
  } else if (delta < -0.4) {
    headline = 'Trending down';
    trajectoryTone = 'down';
  } else {
    headline = 'Steady';
    trajectoryTone = 'flat';
  }
  const headlineColor =
    trajectoryTone === 'up' ? '#1F7A3D' :
    trajectoryTone === 'down' ? '#9A6A20' :
    TEXT_M;

  const chart = vdotSamples.length >= 2
    ? buildBenchmarkTrendChart(vdotSamples, '#10B981', 'rgba(16,185,129,0.08)', '', false)
    : `<div style="text-align:center;padding:16px 8px;font-size:12px;color:${TEXT_S}">${sampleCount === 0 ? 'No VDOT samples yet. Connect a watch or sync Strava.' : `${sampleCount} sample${sampleCount === 1 ? '' : 's'} so far: at least 4 are needed to call a trend.`}</div>`;

  // Adaptation card — mirrors the tri per-discipline card layout. Running is
  // single-discipline so this is one card: header (sport, ratio), centered
  // bar showing position along the 0.70–1.30 scale, then the signal rows
  // (RPE + HR/physiology) consolidated underneath.
  const adaptationCard = adaptation != null ? (() => {
    const clamped = Math.max(0.7, Math.min(1.3, adaptation));
    const pct = ((clamped - 0.7) / 0.6) * 100;
    const tone = adaptation >= 1.05 ? '#16A34A' : adaptation <= 0.95 ? '#D97706' : TEXT_S;
    return { tone, pct, ratio: adaptation };
  })() : null;

  const samplesValue = sampleCount === 0
    ? '0 (need 4+)'
    : `${sampleCount}${sampleCount < 4 ? ` (need ${4 - sampleCount} more)` : ''}`;

  // ── Signals feeding the model ────────────────────────────────────────────
  // Three inputs adjust VDOT beyond the base measurement:
  //   1) RPE feedback from weekly check-ins (`s.rpeAdj`)
  //   2) Physiological signals from synced runs: HR efficiency, drift, HRV,
  //      RHR, collapsed into `s.physioAdj` by `events.ts:applyAutoLTUpdate`.
  //   3) Direct race outcomes (logged on `runRaceLog`) feed back through
  //      blendPredictions.
  const rpeAdj = s.rpeAdj ?? 0;
  const physioAdj = s.physioAdj ?? 0;

  // Count actual check-ins (per-session RPE ratings + week debriefs).
  // `s.rpeAdj` is the net adjustment, so it can be ~0 even when many check-ins
  // have been logged (a hard week and an easy week cancel). Detect the presence
  // of check-ins from raw inputs, not the net value.
  const ratedCount = (s.wks ?? []).reduce(
    (n: number, wk: any) => n + Object.keys(wk?.ratedChanges ?? {}).length,
    0,
  );
  const debriefCount = (s as any).lastCompleteDebriefWeek != null ? 1 : 0;
  const rpeCheckinCount = ratedCount + debriefCount;
  const rpeHasSignal = rpeCheckinCount > 0;

  const signalRow = (label: string, value: number, populated: boolean, populatedSource: string, missingExplanation: string, infoIconHtml: string = ''): string => {
    const sign = value >= 0 ? '+' : '';
    const valueColor = value > 0.1 ? '#1F7A3D' : value < -0.1 ? '#9A6A20' : TEXT_M;
    const valueDisplay = populated
      ? `<span style="font-variant-numeric:tabular-nums;color:${valueColor};font-weight:600">${sign}${value.toFixed(1)}</span>`
      : `<span style="color:${TEXT_L};font-size:12px;font-style:italic">No signal</span>`;
    return `
      <div style="padding:10px 0;border-top:1px solid rgba(0,0,0,0.04);font-size:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px">
          <span style="color:${populated ? TEXT_M : TEXT_L}">${escapeText(label)}${infoIconHtml}</span>
          ${valueDisplay}
        </div>
        <div style="font-size:11px;color:${TEXT_L};line-height:1.4">${escapeText(populated ? populatedSource : missingExplanation)}</div>
      </div>
    `;
  };

  const rpeSource = rpeHasSignal
    ? Math.abs(rpeAdj) <= 0.05
      ? `${rpeCheckinCount} check-in${rpeCheckinCount === 1 ? '' : 's'} logged. Net adjustment is neutral. Sessions are landing as planned.`
      : `${rpeCheckinCount} check-in${rpeCheckinCount === 1 ? '' : 's'} from per-session ratings and weekly debriefs.`
    : '';

  const hrPhysioInfoIcon = buildInfoIcon(
    'resp-hr-physio',
    'HR / physiology',
    '<p style="margin:0 0 8px 0">A composite signal from synced runs. We watch four things: <strong>HR efficiency</strong> (pace held per beat), <strong>cardiac drift</strong> (HR creep at steady pace), <strong>HRV</strong> (overnight recovery quality), and <strong>resting HR</strong> (baseline trend).</p><p style="margin:0">When these point in the same direction, the model nudges your VDOT up or down. Requires a watch syncing HR + HRV data.</p>',
  );

  // Single-discipline adaptation card (mirrors the tri per-discipline card
  // shape: header → ratio → bar → signal rows in one tight block).
  const runningAdaptationCard = adaptationCard ? `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <span style="display:flex;align-items:center;gap:8px;font-size:14px;color:${TEXT_M};font-weight:600">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#16A34A"></span>
          Running
        </span>
        <span style="font-size:18px;font-weight:600;color:${adaptationCard.tone};font-variant-numeric:tabular-nums">${adaptationCard.ratio.toFixed(2)}</span>
      </div>
      <div style="position:relative;height:6px;border-radius:3px;background:rgba(15,23,42,0.07);overflow:hidden;margin-bottom:10px">
        <div style="position:absolute;left:50%;top:0;height:100%;width:1px;background:rgba(15,23,42,0.20)"></div>
        <div style="position:absolute;left:0;top:0;height:100%;width:${adaptationCard.pct.toFixed(1)}%;background:${adaptationCard.tone};border-radius:3px"></div>
      </div>
      ${signalRow(
        'RPE feedback',
        rpeAdj,
        rpeHasSignal,
        rpeSource,
        'No check-ins logged yet. Weekly check-ins on the Plan view feed this signal.',
      )}
      ${signalRow(
        'HR / physiology',
        physioAdj,
        Math.abs(physioAdj) > 0.05,
        'From HR efficiency, drift, HRV, and RHR on synced runs.',
        'Requires a watch. Connect Garmin or Apple Health for HR-based VDOT adjustment.',
        hrPhysioInfoIcon,
      )}
    </div>
  ` : `
    <div style="${CARD};margin-bottom:14px;text-align:center">
      <div style="font-size:13px;color:${TEXT_S};line-height:1.5">Log a few weeks of sessions for the adaptation signal to build.</div>
    </div>
  `;

  // VDOT trajectory + history sparkline in one combined card below the
  // adaptation block. The trajectory headline is descriptive context for the
  // sparkline; pulling them into one card avoids the previous 5-card stack.
  const trajectoryCard = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
        <div>
          <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">VDOT trajectory</div>
          <div style="font-size:18px;font-weight:600;color:${headlineColor};letter-spacing:-0.01em">${headline}</div>
        </div>
        ${sampleCount >= 4 ? `<div style="font-size:11px;color:${TEXT_L}">${windowDays}d, ${sampleCount} samples${sampleCount >= 2 ? ` · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}` : ''}</div>` : `<div style="font-size:11px;color:${TEXT_L}">${samplesValue}</div>`}
      </div>
      ${chart}
    </div>
  `;

  const body = `
    ${runningAdaptationCard}
    ${trajectoryCard}
    ${renderPenaltiesCard(s)}
    ${captionCard('Adaptation tracks how fast you respond vs population average. 1.00 = on track. Above 1.05 the model credits faster horizon gains; below 0.95 it tempers them. Signals you have not yet generated count as 0 — they neither help nor hurt, but the discipline only moves once at least one signal is present. The Active penalties card surfaces any blend-time discounts the engine applies for low volume, missing race history, or other gating signals.')}
  `;

  return {
    title: 'Response',
    subhead: 'How you are responding to the training',
    body,
  };
}

function pageTraining(s: SimulatorState): { title: string; subhead: string; body: string } {
  const phase = (s.wks ?? [])[(s.w ?? 1) - 1]?.ph ?? '—';
  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1);
  const wks = s.wks ?? [];
  const currentWeek = Math.max(1, Math.min(wks.length, s.w ?? 1));
  const unitPref = s.unitPref ?? 'km';

  // ── Build an 8-bar timeline ending at the current plan week ──────────────
  // Combine pre-plan Strava history (`s.historicWeeklyKm`, oldest-first) with
  // in-plan weeks (`s.wks[].garminActuals`). Falls back gracefully when either
  // source is empty.
  type Bar = { label: string; km: number; sessions: number | null; hasData: boolean; isCurrent: boolean; isPrePlan: boolean };
  const bars: Bar[] = [];

  // In-plan first (newest at the right), compute per-week actual km from sync.
  const planBars: Bar[] = wks.slice(0, currentWeek).map((wk, i) => {
    const seen = new Set<string>();
    let km = 0; let sessions = 0;
    for (const a of Object.values(wk?.garminActuals ?? {})) {
      if (a.garminId && seen.has(a.garminId)) continue;
      if (a.garminId) seen.add(a.garminId);
      if (typeof a.distanceKm === 'number' && a.distanceKm > 0) { km += a.distanceKm; sessions += 1; }
    }
    return {
      label: `W${i + 1}`,
      km,
      sessions,
      hasData: km > 0,
      isCurrent: i + 1 === currentWeek,
      isPrePlan: false,
    };
  });

  // Pre-plan slice. Take last (8 - planBars.length) entries from historicWeeklyKm.
  const historicKm = s.historicWeeklyKm ?? [];
  const prePlanNeeded = Math.max(0, 8 - planBars.length);
  const prePlanSlice = historicKm.slice(-prePlanNeeded);
  const prePlanBars: Bar[] = prePlanSlice.map((km, i) => ({
    label: `-${prePlanSlice.length - i}w`,
    km,
    sessions: null,
    hasData: km > 0,
    isCurrent: false,
    isPrePlan: true,
  }));

  bars.push(...prePlanBars, ...planBars);

  // Numbers for the headline + rows
  const planBarsWithData = planBars.filter(b => b.hasData);
  const inPlanAvgKm = planBarsWithData.length > 0
    ? planBarsWithData.reduce((s, b) => s + b.km, 0) / planBarsWithData.length
    : 0;
  const baseline = s.detectedWeeklyKm ?? 0;
  const baselineFromHistory = historicKm.length > 0
    ? historicKm.reduce((a, b) => a + b, 0) / historicKm.length
    : 0;
  const trueBaseline = baseline > 0 ? baseline : baselineFromHistory;

  // Headline policy: use in-plan avg only once at least 2 plan weeks have
  // actual data: otherwise the headline is the pre-plan baseline, with the
  // single in-plan week shown as a secondary "this week so far" line. This
  // stops "Recent volume: 4 km/wk" from displacing the real recent baseline
  // (18 km/wk) when the plan has just started.
  const useInPlanHeadline = planBarsWithData.length >= 2;
  const headlineKm = useInPlanHeadline ? inPlanAvgKm : trueBaseline;
  const headlineLabel = useInPlanHeadline ? 'In-plan average' : 'Recent (pre-plan)';
  const headlineSubtitle = useInPlanHeadline
    ? `${planBarsWithData.length}w in plan, ${Math.round(planBarsWithData.reduce((s, b) => s + (b.sessions ?? 0), 0) / planBarsWithData.length)} sessions/wk avg`
    : `8-week Strava average before plan started`;

  // ── Area-line chart of weekly km ─────────────────────────────────────────
  // Mirrors the canonical `buildBenchmarkTrendChart` pattern: SVG area path
  // with non-scaling stroke, no decorative shapes inside, explicit height +
  // preserveAspectRatio="none" per UX_PATTERNS.
  const dataBars = bars.filter(b => b.hasData);
  const referenceKm = trueBaseline > 0 ? trueBaseline : 0;
  const maxKm = Math.max(referenceKm * 1.2, ...bars.map(b => b.km), 10);
  const W = 320, H = 110, padL = 6, padR = 6, padT = 4, padB = 4;
  const usableW = W - padL - padR;
  const usableH = H - padT - padB;
  const xOf = (i: number) => padL + (bars.length <= 1 ? usableW / 2 : i * usableW / (bars.length - 1));
  const yOf = (km: number) => padT + (1 - km / maxKm) * usableH;

  let svgChart = '';
  if (dataBars.length >= 1 && bars.length >= 1) {
    const pts: [number, number][] = bars.map((b, i) => [xOf(i), yOf(b.km)]);
    const topPath = smoothAreaPath(pts);
    const areaPath = `${topPath} L ${xOf(bars.length - 1).toFixed(1)} ${(H - padB).toFixed(1)} L ${xOf(0).toFixed(1)} ${(H - padB).toFixed(1)} Z`;
    const refY = yOf(referenceKm).toFixed(1);

    svgChart = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
        ${referenceKm > 0 ? `
          <line x1="${padL}" y1="${refY}" x2="${W - padR}" y2="${refY}"
            stroke="rgba(15,23,42,0.35)" stroke-width="1" stroke-dasharray="4 4"
            vector-effect="non-scaling-stroke"/>
        ` : ''}
        <path d="${areaPath}" fill="rgba(59,130,246,0.10)" stroke="none"/>
        <path d="${topPath}" fill="none" stroke="#3B82F6" stroke-width="1.75"
          stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      </svg>
    `;
  }

  const referenceCaption = referenceKm > 0
    ? `<div style="display:flex;justify-content:flex-end;font-size:10px;color:${TEXT_S};margin-top:6px">
         <span><span style="display:inline-block;width:14px;height:0;border-top:1px dashed rgba(15,23,42,0.45);margin-right:5px;vertical-align:middle"></span>8w avg ${formatKm(referenceKm, unitPref, 0)}/wk</span>
       </div>`
    : '';

  const xAxisLabels = bars.length > 0 ? `
    <div style="display:flex;margin-top:4px;padding:0 ${padR}px 0 ${padL}px">
      ${bars.map((b) => {
        const isLast = b.isCurrent;
        return `<div style="flex:1;text-align:center;font-size:9px;color:${isLast ? TEXT_M : TEXT_L};font-weight:${isLast ? '600' : '400'};white-space:nowrap;min-width:0">${b.label}</div>`;
      }).join('')}
    </div>
  ` : '';

  const barChart = bars.length === 0 || dataBars.length === 0
    ? `<div style="text-align:center;padding:24px 8px;font-size:12px;color:${TEXT_S}">No weekly km history yet. Sync Strava to populate.</div>`
    : `
      <div style="position:relative">${svgChart}</div>
      ${xAxisLabels}
      ${referenceCaption}
    `;

  // Secondary "this week" line. Only when there's an in-plan partial week
  const currentBar = planBars[planBars.length - 1];
  const thisWeekLine = !useInPlanHeadline && currentBar && currentBar.hasData
    ? `<div style="font-size:12px;color:${TEXT_S};margin-top:6px">This week so far: ${formatKm(currentBar.km, unitPref, 1)} · ${currentBar.sessions} session${currentBar.sessions === 1 ? '' : 's'}</div>`
    : '';

  const body = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <div>
          <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">${headlineLabel}</div>
          <div style="font-size:28px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">
            ${headlineKm > 0 ? formatKm(headlineKm, unitPref, 0) + '/wk' : '—'}
          </div>
        </div>
        <div style="text-align:right;font-size:11px;color:${TEXT_L};max-width:140px;line-height:1.4">
          ${escapeText(headlineSubtitle)}
        </div>
      </div>
      ${thisWeekLine}
      <div style="margin-top:18px">${barChart}</div>
    </div>

    <div style="${CARD};margin-bottom:14px">
      ${trueBaseline > 0 ? statRow('Pre-plan baseline', `${formatKm(trueBaseline, unitPref, 0)}/wk`) : ''}
      ${statRow('Phase', phaseLabel)}
      ${statRow('Week', `${currentWeek} of ${s.tw ?? wks.length}`)}
    </div>

    ${renderTandaCard(s)}

    ${captionCard(useInPlanHeadline
      ? 'This is the training history the forecast is using right now. The model weights recent in-plan weeks heavily; pre-plan history fills the rest of the window so the baseline does not collapse on Week 1 of a fresh plan. The Tanda card above shows whether your volume + pace data is rich enough to feed the marathon-specific predictor (gates: ≥4 weeks of history AND at least medium pace confidence AND not stale).'
      : 'This is the training history the forecast is using right now. At Week 1, that is almost entirely your pre-plan Strava baseline. As plan weeks accumulate, the in-plan bars take over.'
    )}
  `;

  return { title: 'Training', subhead: 'Training history feeding the forecast', body };
}

// ── Tanda eligibility + filter transparency ──────────────────────────────────
//
// Marathon-only. The Tanda 2011 predictor (volume × pace) is gated on data
// quality. Surface the gates so users see what's behind the km/wk number.

function renderTandaCard(s: SimulatorState): string {
  const isMarathon = (s.rd ?? 'marathon') === 'marathon';
  if (!isMarathon) return '';

  const runs = collectRunsFromState(s);
  const inputs = computePredictionInputs(runs);

  const trusted = inputs.weeksCovered >= 4
    && (inputs.paceConfidence === 'high' || inputs.paceConfidence === 'medium')
    && !inputs.isStale;

  const statusColor = trusted ? '#1F7A3D' : '#9A6A20';
  const statusLabel = trusted ? 'Firing' : 'Gated';

  // Gates list. Each gate either passes or fails. Honest about why.
  const gates: Array<{ label: string; passed: boolean; detail: string }> = [
    {
      label: 'Weeks of history',
      passed: inputs.weeksCovered >= 4,
      detail: `${inputs.weeksCovered} of 4 minimum`,
    },
    {
      label: 'Pace confidence',
      passed: inputs.paceConfidence === 'high' || inputs.paceConfidence === 'medium',
      detail: inputs.paceConfidence,
    },
    {
      label: 'Freshness',
      passed: !inputs.isStale,
      detail: inputs.isStale ? 'data >2 weeks old' : 'recent data',
    },
  ];

  const gatesHtml = gates.map(g => {
    const dot = g.passed
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#16A34A"></span>`
      : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#C48A3A"></span>`;
    return `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.04)">
        <span style="display:flex;align-items:center;gap:8px;color:${TEXT_M}">${dot}${escapeText(g.label)}</span>
        <span style="color:${g.passed ? TEXT_M : TEXT_S};font-variant-numeric:tabular-nums">${escapeText(g.detail)}</span>
      </div>
    `;
  }).join('');

  const inputsBlock = trusted ? `
    <div style="padding:9px 0;font-size:12px;color:${TEXT_S};line-height:1.5;border-top:1px solid rgba(0,0,0,0.04);margin-top:4px">
      Feeding Tanda: <strong style="color:${TEXT_M}">K = ${(inputs.weeklyKm ?? 0).toFixed(0)} km/wk</strong>,
      <strong style="color:${TEXT_M}">P = ${formatLtPace(inputs.avgPaceSecPerKm ?? 0, s.unitPref ?? 'km')}</strong>
      across ${inputs.weeksCovered} weeks.
    </div>
  ` : '';

  return `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:14px;color:${TEXT_S};font-weight:500">Tanda eligibility</span>
        <span style="font-size:13px;color:${statusColor};font-weight:600">${statusLabel}</span>
      </div>
      <div style="font-size:11px;color:${TEXT_L};line-height:1.4;margin-bottom:4px">
        Marathon-only outcome-calibrated predictor (Tanda 2011, r=0.91 vs 46 finishers). When firing, carries 30% of the blend.
      </div>
      ${gatesHtml}
      ${inputsBlock}
    </div>
  `;
}

function pageVenue(s: SimulatorState): { title: string; subhead: string; body: string } {
  const factors = s.forecastCourseFactors ?? [];
  const raceName = s.selectedMarathon?.name ?? 'No race selected';
  const rawSec = s.forecastTime ?? 0;
  const adjustedSec = s.forecastTimeAdjusted ?? rawSec;
  const totalDeltaSec = adjustedSec - rawSec;
  const compoundedMult = factors.reduce((acc, f) => acc * f.multiplier, 1);
  const totalPct = (compoundedMult - 1) * 100;
  const totalSign = totalPct >= 0 ? '+' : '−';
  const slowerOrFaster = totalPct >= 0 ? 'slower' : 'faster';

  if (factors.length === 0) {
    return {
      title: 'Venue',
      subhead: raceName,
      body: emptyStateCard(
        s.selectedMarathon
          ? 'No course adjustments applied. The course is venue-neutral or no profile is loaded.'
          : 'No race selected yet.',
        s.selectedMarathon ? '' : 'Pick a target race on the Account page.',
      ),
    };
  }

  // Visual factor bars. Each factor's % impact as a horizontal bar.
  // Anchor: largest absolute factor sets the 100% width; others scale relative.
  const maxAbsPct = Math.max(...factors.map(f => Math.abs((f.multiplier - 1) * 100)), 0.5);

  const factorBars = factors.map(f => {
    const pct = (f.multiplier - 1) * 100;
    const sign = pct >= 0 ? '+' : '−';
    const widthPct = (Math.abs(pct) / maxAbsPct) * 100;
    const deltaSec = rawSec * (f.multiplier - 1);
    const tone = pct >= 0 ? '#C48A3A' : '#5a8050';
    const toneFill = pct >= 0 ? 'rgba(196,138,58,0.18)' : 'rgba(90,128,80,0.18)';
    return `
      <div style="padding:12px 0;border-top:1px solid rgba(0,0,0,0.04)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <div>
            <span style="font-size:13px;color:${TEXT_M};font-weight:500">${escapeText(f.label)}</span>
            <span style="font-size:11px;color:${TEXT_S};margin-left:6px">${escapeText(f.value)}</span>
          </div>
          <span style="font-size:13px;color:${tone};font-variant-numeric:tabular-nums">${sign}${Math.abs(pct).toFixed(1)}% (${sign}${ft(Math.abs(deltaSec))})</span>
        </div>
        <div style="position:relative;height:6px;border-radius:3px;background:${toneFill};overflow:hidden">
          <div style="position:absolute;left:0;top:0;height:100%;width:${widthPct.toFixed(1)}%;background:${tone};border-radius:3px"></div>
        </div>
      </div>
    `;
  }).join('');

  // Field-check: only when we've ingested real finisher data for this venue.
  const venueId = s.selectedMarathon?.id;
  const fieldCheckRow = venueId ? buildFieldCheckRow(venueId) : '';

  // Sources: only papers behind factors actually in play. De-duplicate.
  const sourcesBlock = buildSourcesBlock(factors);

  const body = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
        <div>
          <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">${escapeText(raceName)}</div>
          <div style="font-size:24px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em">${totalSign}${Math.abs(totalPct).toFixed(1)}% ${slowerOrFaster}</div>
          <div style="font-size:12px;color:${TEXT_S};margin-top:4px">vs flat, cool, sea level</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:${TEXT_L};margin-bottom:2px">Net cost</div>
          <div style="font-size:18px;color:${TEXT_M};font-variant-numeric:tabular-nums">${totalDeltaSec >= 0 ? '+' : '−'}${ft(Math.abs(totalDeltaSec))}</div>
        </div>
      </div>
    </div>

    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:6px">Factor breakdown</div>
      ${factorBars}
    </div>

    <div style="${CARD};margin-bottom:14px">
      ${statRow('Raw fitness pace', ft(rawSec))}
      ${statRow('Adjusted finish', ft(adjustedSec))}
      ${fieldCheckRow}
    </div>

    ${sourcesBlock}

    ${captionCard('Climate dominates at hot venues even when the course is flat. Effects compound where altitude or elevation gain stack on top.')}
  `;

  return { title: 'Venue', subhead: `${raceName} course adjustments`, body };
}

/** Build the field-check row from ingested finisher data, or empty string. */
function buildFieldCheckRow(venueId: string): string {
  const prov = VENUE_DATA_PROVENANCE[venueId];
  const table = VENUE_PERCENTILE_TABLES[venueId];
  if (!prov || prov.source === 'none' || !table || table.length === 0) return '';
  // Find p50 directly; tables include a 50th-percentile entry by construction.
  const medianEntry = table.find(([, p]) => p === 50);
  if (!medianEntry) return '';
  const medianSec = medianEntry[0];
  const nLabel = prov.n ? `n=${prov.n.toLocaleString('en-GB')}` : '';
  const yearsLabel = prov.years ?? '';
  const meta = [nLabel, yearsLabel].filter(Boolean).join(', ');
  return `
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.04)">
      <span style="color:${TEXT_S}">Field median${meta ? ` <span style="color:${TEXT_L};font-size:11px">${escapeText(meta)}</span>` : ''}</span>
      <span style="color:${TEXT_M};font-variant-numeric:tabular-nums">${ft(medianSec)}</span>
    </div>
  `;
}

/** Build the Sources card from factors actually in play. */
function buildSourcesBlock(factors: NonNullable<SimulatorState['forecastCourseFactors']>): string {
  if (factors.length === 0) return '';
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const f of factors) {
    const src = RUNNING_FACTOR_SOURCES[f.kind];
    if (!src || seen.has(src.citation)) continue;
    seen.add(src.citation);
    rows.push(`
      <div style="padding:10px 0;border-top:1px solid rgba(0,0,0,0.04);font-size:12px;line-height:1.5">
        <div style="color:${TEXT_M};font-weight:500">${escapeText(src.citation)}</div>
        <div style="color:${TEXT_S}">${escapeText(src.title)}</div>
        <div style="color:${TEXT_L}">${escapeText(src.journal)}</div>
      </div>
    `);
  }
  if (rows.length === 0) return '';
  return `
    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Sources</div>
      ${rows.join('')}
    </div>
  `;
}

function pageFor(key: ChipKey, s: SimulatorState): { title: string; subhead: string; body: string } {
  switch (key) {
    case 'you':         return pageYou(s);
    case 'capacity':    return pageCapacity(s);
    case 'response':    return pageResponse(s);
    case 'training':    return pageTraining(s);
    case 'venue':       return pageVenue(s);
    case 'durability':  return pageDurability(s);
    case 'heat':        return pageHeat(s);
    case 'calibration': return pageCalibration(s);
    case 'shoes':       return pageShoes(s);
  }
}

// ── Shoes drilldown ──────────────────────────────────────────────────────────

function buildShoesToggleCardHTML(s: SimulatorState): string {
  const kind = s.shoeKind ?? 'standard';
  const isCarbon = kind === 'supershoes';
  const tone = isCarbon ? '#16A34A' : TEXT_S;
  const headline = isCarbon ? '+3% pace' : 'No boost applied';
  const detail = isCarbon
    ? 'Race-day prediction credits carbon-plated racing flats. Adjust the assumed time if you switch back.'
    : 'Switch to supershoes if you plan to race in carbon-plated flats (Vaporfly, Alphafly, Adios Pro, Endorphin Elite, etc.).';

  // Live forecast readout so the user sees the time change as they toggle.
  const forecastSec = s.forecastTimeAdjusted ?? s.forecastTime ?? 0;
  const forecastRow = forecastSec > 0 ? `
    <div style="padding:10px 0;border-top:1px solid rgba(0,0,0,0.06);margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:12px;color:${TEXT_S}">Your forecast</span>
        <span style="font-size:14px;color:${TEXT_M};font-weight:600;font-variant-numeric:tabular-nums">${ft(forecastSec)}</span>
      </div>
    </div>
  ` : '';

  // Segmented-control toggle with depth. Active = raised filled chip (subtle
  // outer shadow), inactive = inset / recessed look against the track. The
  // outer track has a soft inset shadow so the inactive side reads as a
  // pressed-into-track surface rather than a flat button.
  const segTrack = 'background:rgba(15,23,42,0.05);border-radius:100px;padding:4px;box-shadow:inset 0 1px 2px rgba(15,23,42,0.10),inset 0 0 0 1px rgba(15,23,42,0.04)';
  const segActive = `background:#fff;color:${TEXT_M};box-shadow:0 1px 2px rgba(15,23,42,0.08),0 4px 10px rgba(15,23,42,0.10),inset 0 0 0 1px rgba(15,23,42,0.04)`;
  const segInactive = `background:transparent;color:${TEXT_S};box-shadow:none`;
  const segBtn = (id: string, label: string, active: boolean) => `
    <button id="${id}" type="button" data-active="${active}" style="
      flex:1;padding:10px 14px;border-radius:100px;border:none;
      font:inherit;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f);
      transition:background 0.18s cubic-bezier(0.2,0.8,0.2,1),
                 color 0.18s cubic-bezier(0.2,0.8,0.2,1),
                 box-shadow 0.18s cubic-bezier(0.2,0.8,0.2,1);
      -webkit-tap-highlight-color:transparent;
      ${active ? segActive : segInactive}
    ">${label}</button>
  `;

  return `
    <div id="fcd-shoes-card" style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <span style="font-size:14px;color:${TEXT_M};font-weight:600">Race-day shoes</span>
        <span style="font-size:18px;font-weight:600;color:${tone};font-variant-numeric:tabular-nums">${headline}</span>
      </div>
      <div style="font-size:12px;color:${TEXT_S};line-height:1.5;margin-bottom:14px">${detail}</div>
      <div style="display:flex;gap:0;${segTrack}">
        ${segBtn('fcd-shoes-standard',   'Standard',   !isCarbon)}
        ${segBtn('fcd-shoes-supershoes', 'Supershoes',  isCarbon)}
      </div>
      ${forecastRow}
    </div>
  `;
}

function pageShoes(s: SimulatorState): { title: string; subhead: string; body: string } {
  const toggleCard = buildShoesToggleCardHTML(s);

  const body = `
    ${toggleCard}
    ${captionCard('Carbon-plated racing shoes (Vaporfly, Alphafly, Adios Pro, Endorphin Elite, Metaspeed) deliver a 2.7–4.2% running-economy improvement at marathon pace, mean ~3% (Hoogkamer et al. 2018; Barnes &amp; Kilding 2019). The boost comes from the stiff carbon plate reducing energy lost at the metatarsophalangeal joint, combined with a high-rebound foam (PEBA-based) that returns more energy on toe-off. Effect tapers slightly at slower paces but stays meaningful above 5:30/km. Mosaic applies the boost as a flat 3% pace adjustment on your forecast and race-day projection when supershoes are selected. If you train in regular shoes and race in supershoes, the cone widens at race day to reflect that you have not specifically practiced the race-shoe feel.')}
  `;

  return { title: 'Shoes', subhead: 'Race-day footwear', body };
}

// ── New drill-down pages (durability / heat / calibration) ──────────────────

function pageDurability(s: SimulatorState): { title: string; subhead: string; body: string } {
  const d = s.runDurability;
  if (!d) {
    return {
      title: 'Durability',
      subhead: 'Long-run readiness for race distance',
      body: `<div style="${CARD};text-align:center"><div style="font-size:14px;color:${TEXT_M};line-height:1.5">Sync a few runs to compute durability.</div></div>`,
    };
  }
  const longestMin = Math.round(d.longestRunSec / 60);
  const thresholdMin = Math.round(d.thresholdSec / 60);
  const pct = Math.min(100, d.metFraction * 100);
  const capped = d.limitingFactor === 'long_run_shortfall';
  const tone = capped ? '#C48A3A' : '#16A34A';
  const penalty = Math.max(0, (d.multiplier - 1) * 100);

  // Accumulated time-on-feet: repeated long-run exposure, not just the single
  // peak. A long run qualifies at 70% of the threshold; regular ones soften the
  // peak-shortfall penalty (Pfitzinger: a long run every 7-10 days through a build).
  const cnt = d.qualifyingLongRunCount ?? 0;
  const tgt = d.consistencyTarget ?? 8;
  const creditPct = Math.round((d.consistencyCredit ?? 0) * 100);
  const qualMin = Math.round((d.thresholdSec * 0.70) / 60);
  const consistencyPct = Math.min(100, (cnt / Math.max(1, tgt)) * 100);
  const consistencyLine = capped
    ? creditPct > 0
      ? `Regular long runs are offsetting the shortfall. ${cnt} of ${tgt} logged in the window, reducing today's penalty by ${creditPct}%.`
      : `No long runs over ${qualMin} min in the window. One every 10 days builds durability a single peak run cannot.`
    : `${cnt} of ${tgt} long runs logged. Consistent time on feet maintains durability between peak efforts.`;

  // Race-day durability: the same cap on the runs the plan prescribes in the 12
  // weeks before race day (race-day-durability.ts). The forecast applies this
  // exact stored result, so the page and the forecast cannot disagree.
  const rdd = s.raceDayDurability;
  const rddPenalty = rdd ? Math.max(0, (rdd.multiplier - 1) * 100) : 0;
  const rddLongestMin = rdd ? Math.round(rdd.longestRunSec / 60) : 0;
  // A marathon plan whose longest run stays under the long-run bar is outside the
  // model's calibration: say so instead of quoting a precise penalty.
  const enduranceGap = raceDayEnduranceGapText(rdd, s.rd);
  const raceDayLine = !rdd
    ? (capped ? 'The race-day forecast does not carry this penalty.' : '')
    : enduranceGap
      ? enduranceGap
      : rddPenalty > 0
      ? `The plan's longest run before race day is ${rddLongestMin} min, short of the ${thresholdMin}-min threshold. The race-day forecast carries a ${rddPenalty.toFixed(2)}% durability penalty.`
      : rdd.metFraction >= 1
        ? `The plan builds a ${rddLongestMin}-min long run by race day. The race-day forecast carries no durability penalty.`
        : `The plan prescribes ${rdd.qualifyingLongRunCount} long runs over ${qualMin} min before race day, which offsets the shortfall. The race-day forecast carries no durability penalty.`;
  const bannerText = [capped ? "Today's prediction has the run capped by recent durability." : '', (capped || rddPenalty > 0) ? raceDayLine : '']
    .filter(Boolean).join(' ');
  const banner = bannerText ? `
    <div style="margin-bottom:14px;padding:12px 14px;border-radius:10px;background:rgba(196,138,58,0.10);font-size:13px;color:#6B5B2E;line-height:1.5">
      ${bannerText}
    </div>
  ` : '';

  return {
    title: 'Durability',
    subhead: 'Long-run readiness for race distance',
    body: `
      ${banner}
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
          <div>
            <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Longest single run</div>
            <div style="font-size:28px;font-weight:600;color:${tone};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${longestMin} min</div>
          </div>
          <div style="text-align:right;font-size:11px;color:${TEXT_L};line-height:1.5">
            Threshold for ${s.rd ?? 'marathon'}<br/>
            <span style="color:${TEXT_M};font-weight:600">${thresholdMin} min</span>
          </div>
        </div>
        <div style="position:relative;height:6px;border-radius:3px;background:rgba(15,23,42,0.07);overflow:hidden;margin-bottom:8px">
          <div style="position:absolute;left:0;top:0;height:100%;width:${pct.toFixed(1)}%;background:${tone};border-radius:3px"></div>
        </div>
        <div style="font-size:11px;color:${TEXT_L}">${capped ? `${(100 - pct).toFixed(0)}% shortfall from threshold` : 'Threshold met. No penalty'}</div>
        <div style="border-top:1px solid rgba(15,23,42,0.07);margin-top:12px;padding-top:12px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
            <div style="font-size:12px;color:${TEXT_S};font-weight:500">Long runs (time on feet)</div>
            <div style="font-size:13px;font-weight:600;color:${TEXT_M};font-variant-numeric:tabular-nums">${cnt} of ${tgt}</div>
          </div>
          <div style="position:relative;height:6px;border-radius:3px;background:rgba(15,23,42,0.07);overflow:hidden;margin-bottom:8px">
            <div style="position:absolute;left:0;top:0;height:100%;width:${consistencyPct.toFixed(1)}%;background:${tone};border-radius:3px"></div>
          </div>
          <div style="font-size:11px;color:${TEXT_L};line-height:1.5">${consistencyLine}</div>
        </div>
      </div>
      <div style="${CARD};margin-bottom:14px">
        ${statRow('Penalty applied today', penalty > 0 ? `+${penalty.toFixed(2)}%` : 'None')}
        ${statRow('Long runs logged (12 wks)', `${cnt} of ${tgt}`)}
        ${statRow('Applied to race-day forecast', rddPenalty > 0 ? `+${rddPenalty.toFixed(2)}%` : 'None')}
        ${rdd ? statRow("Plan's longest run before race day", `${rddLongestMin} min`) : ''}
        ${statRow('Look-back window', '12 weeks')}
      </div>
      ${captionCard('Durability is an asymmetric cap: it can only slow you down, never speed you up. Two things lift it: a single long run reaching the distance threshold, or regular time on feet (a long run over ' + qualMin + ' min roughly every 10 days). Repeated long runs build the same connective-tissue durability a peak run does, so they buy down the shortfall penalty. The race-day forecast applies the same cap to the runs the plan prescribes in the 12 weeks before race day. Beyond threshold, additional long-session volume shows up in <strong>Capacity</strong> (VDOT) and <strong>Training</strong> (weekly km), not here. Calibrated against Karp 2007, Daniels 2014, Pfitzinger 2009. see SCIENCE_LOG §H-run.')}
    `,
  };
}

function pageHeat(s: SimulatorState): { title: string; subhead: string; body: string } {
  const factors = s.forecastCourseFactors ?? [];
  const climateFactor = factors.find(f => f.kind === 'climate');
  const heatFactor = factors.find(f => f.kind === 'heat-acclim');
  const climate = s.selectedMarathon?.profile?.climate ?? null;

  if (!climate || climate === 'cool') {
    return {
      title: 'Heat',
      subhead: 'Acclimatisation vs race climate',
      body: `<div style="${CARD};text-align:center"><div style="font-size:14px;color:${TEXT_M};line-height:1.5">Heat factor only fires for warm/hot races.</div></div>`,
    };
  }

  const climatePct = climateFactor ? (climateFactor.multiplier - 1) * 100 : 0;
  const climateSec = climateFactor?.deltaSec ?? 0;
  const heatSavedSec = -(heatFactor?.deltaSec ?? 0); // positive = saved
  const heatSavedMin = heatSavedSec / 60;

  // Pull training-temp from the heat factor's value string (engine writes it).
  const tempMatch = heatFactor?.value.match(/Training\s+(\d+)°C\s+vs\s+race\s+(\d+)°C/);
  const trainingTempC = tempMatch ? Number(tempMatch[1]) : null;
  const raceAnchorC = tempMatch ? Number(tempMatch[2]) : null;

  return {
    title: 'Heat',
    subhead: `Acclimatisation vs ${climate} race climate`,
    body: `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <div>
            <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Climate penalty</div>
            <div style="font-size:28px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">+${climatePct.toFixed(1)}%</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:${TEXT_L};margin-bottom:2px">Pre-acclim</div>
            <div style="font-size:18px;color:${TEXT_M};font-variant-numeric:tabular-nums">+${ft(climateSec)}</div>
          </div>
        </div>
      </div>

      ${heatFactor ? `
        <div style="${CARD};margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <div>
              <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Acclimatisation discount</div>
              <div style="font-size:24px;font-weight:600;color:#1F7A3D;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">−${heatSavedMin.toFixed(1)} min</div>
            </div>
          </div>
          ${trainingTempC != null ? statRow('Training temperature', `${trainingTempC}°C (last 4 weeks)`) : ''}
          ${raceAnchorC != null ? statRow('Race climate anchor', `${raceAnchorC}°C`) : ''}
          ${statRow('Net effect on prediction', `${heatSavedSec >= 0 ? '−' : '+'}${ft(Math.abs(heatSavedSec))}`)}
        </div>
      ` : `
        <div style="${CARD};margin-bottom:14px;text-align:center">
          <div style="font-size:14px;color:${TEXT_M};line-height:1.5;margin-bottom:6px">No acclimatisation data yet.</div>
          <div style="font-size:12px;color:${TEXT_S};line-height:1.5">Sync at least 4 outdoor runs with weather data over the last 4 weeks. Open-Meteo populates <code>ambientTempC</code> for outdoor activities with a GPS start location.</div>
        </div>
      `}

      ${captionCard('Athletes who train in heat similar to the race climate retain 3 to 5 percent performance compared to athletes who train cool. The engine discounts the physical climate penalty by up to 50 percent when training temperature is within 15°C of the race anchor. And zero when the gap is larger. Lorenzo &amp; Cheuvront 2010; Karlsen et al. 2015. See SCIENCE_LOG §G.heat-run.')}
    `,
  };
}

function pageCalibration(s: SimulatorState): { title: string; subhead: string; body: string } {
  const cal = s.runCalibration;
  if (!cal || cal.tier < 1) {
    return {
      title: 'Calibration',
      subhead: 'Learning from your race history',
      body: `<div style="${CARD};text-align:center"><div style="font-size:14px;color:${TEXT_M};line-height:1.5;margin-bottom:6px">Calibration activates once you have logged at least 2 races at the same distance.</div><div style="font-size:12px;color:${TEXT_S}">${cal?.basedOnRaceCount ? `${cal.basedOnRaceCount} race${cal.basedOnRaceCount === 1 ? '' : 's'} on file. Not enough at any single distance yet.` : 'Log races on the Account page after they happen.'}</div></div>`,
    };
  }

  const biases = cal.perDistanceBiasSec ?? {};
  const distLabel = (d: string): string =>
    d === '5k' ? '5K' : d === '10k' ? '10K' : d === 'half' ? 'Half marathon' : 'Marathon';

  const distRows = Object.entries(biases).map(([dist, bias]) => {
    const sign = bias >= 0 ? '+' : '−';
    const abs = Math.abs(bias);
    const fmt = abs >= 60 ? `${sign}${Math.round(abs / 60)} min ${Math.round(abs % 60)}s` : `${sign}${abs}s`;
    const tone = bias > 0 ? '#9A6A20' : bias < 0 ? '#1F7A3D' : TEXT_M;
    return `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.04)">
        <span style="color:${TEXT_M}">${distLabel(dist)}</span>
        <span style="color:${tone};font-variant-numeric:tabular-nums">${fmt}</span>
      </div>
    `;
  }).join('');

  return {
    title: 'Calibration',
    subhead: `Tier ${cal.tier}. learning from ${cal.basedOnRaceCount} race${cal.basedOnRaceCount === 1 ? '' : 's'}`,
    body: `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
          <div>
            <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Calibration active</div>
            <div style="font-size:28px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">Tier ${cal.tier} <span style="font-size:13px;color:${TEXT_S};font-weight:500">· ${cal.basedOnRaceCount} race${cal.basedOnRaceCount === 1 ? '' : 's'}</span></div>
          </div>
        </div>
        <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:6px;margin-top:6px">Bias by distance</div>
        ${distRows || `<div style="font-size:12px;color:${TEXT_L};padding:6px 0">No bias entries above the 30-second noise floor.</div>`}
      </div>
      ${captionCard('Calibration learns the systematic gap between what the blend predicts and what you actually race. A positive bias means you tend to be slower than the model predicts; the model adds that bias to future predictions at the same distance. Capped at ±8% of median predicted so a single outlier race cannot skew the prediction. Ignored below a 30-second floor to filter noise. Bland &amp; Altman 1986. See SCIENCE_LOG §J.run-calibration.')}
    `,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render the chip-detail page. Replaces app-root with the full page; back
 * button returns to the marathon forecast view.
 */
export function renderForecastChipDetail(key: ChipKey): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const page = pageFor(key, s);

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  container.innerHTML = `
    <style>
      @keyframes fcdFloatUp { from { opacity:0; } to { opacity:1; } }
      .fcd-fade { opacity:0; animation:fcdFloatUp 0.55s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="fcd-view" class="safe-top-bleed" style="
      position:relative;min-height:100dvh;background:${atmosphereGradient('sky')};
      font-family:var(--f);overflow-x:hidden;
    ">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('fcd', { variant: 'whisper', palette: 'sky' })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <div class="fcd-fade" style="animation-delay:0.02s;padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <button id="fcd-back-btn" style="background:transparent;border:none;font-size:14px;color:${TEXT_S};cursor:pointer;padding:0;font-family:var(--f)">← Back</button>
          <button id="fcd-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <div class="fcd-fade" style="animation-delay:0.06s;text-align:center;padding:20px 20px 16px">
          <div style="font-size:11px;color:${TEXT_S};font-weight:500">Forecast factor</div>
          <div style="font-size:30px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;line-height:1.1;margin-top:6px">${escapeText(page.title)}</div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">${escapeText(page.subhead)}</div>
        </div>

        <div class="fcd-fade" style="animation-delay:0.12s;padding:0 16px">
          ${page.body}
        </div>

      </div>

      ${renderTabBar('forecast')}
    </div>
  `;

  const fcdView = document.getElementById('fcd-view');
  if (fcdView) mountInfoPopovers(fcdView);

  document.getElementById('fcd-back-btn')?.addEventListener('click', () => {
    import('./race-forecast-view').then(({ renderRaceForecastView }) => renderRaceForecastView());
  });
  document.getElementById('fcd-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // You-page "Import run history" button: opens the same activity-import modal
  // the onboarding wizard uses. Re-renders the You page on completion so any
  // newly-derived PBs surface immediately.
  document.getElementById('fcd-import-runs')?.addEventListener('click', () => {
    import('./import-activity-modal').then(({ openImportActivityModal }) => {
      openImportActivityModal({ onComplete: () => renderForecastChipDetail(key) });
    });
  });

  // Shoes toggle. In-place update of the toggle card only — avoids the full
  // page reload (and the visible scroll jump) of renderForecastChipDetail.
  // 1) Write shoeKind, save.
  // 2) refreshBlendedFitness updates s.forecastTime with the 3% pace boost.
  // 3) refreshForecastCourseFactors propagates to s.forecastTimeAdjusted.
  // 4) Rebuild #fcd-shoes-card HTML in-place. Re-wire the buttons since the
  //    nodes are replaced.
  const setShoeKind = async (kind: 'standard' | 'supershoes') => {
    const { getMutableState, saveState } = await import('@/state');
    const ms = getMutableState();
    if (ms.shoeKind === kind) return;
    ms.shoeKind = kind;
    saveState();
    const { refreshBlendedFitness } = await import('@/calculations/blended-fitness');
    refreshBlendedFitness(ms);
    const { refreshForecastCourseFactors } = await import('@/calculations/course-factors-running');
    refreshForecastCourseFactors(ms);
    saveState();
    const card = document.getElementById('fcd-shoes-card');
    if (card?.parentElement) {
      card.outerHTML = buildShoesToggleCardHTML(getState());
      wireShoeButtons();
    }
  };
  const wireShoeButtons = () => {
    document.getElementById('fcd-shoes-standard')?.addEventListener('click', () => setShoeKind('standard'));
    document.getElementById('fcd-shoes-supershoes')?.addEventListener('click', () => setShoeKind('supershoes'));
  };
  wireShoeButtons();

  wireTabBarHandlers(navigateTab);
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./main-view').then(m => m.renderMainView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
  else if (tab === 'forecast') import('./race-forecast-view').then(m => m.renderRaceForecastView());
  else if (tab === 'account') import('./account-view').then(m => m.renderAccountView());
}

/**
 * Wire chip click handlers. Attach to the rendered `.rfc-chip` elements.
 * Call after `renderForecastFingerprint`'s HTML lands in the DOM.
 */
export function wireForecastChips(): void {
  document.querySelectorAll<HTMLElement>('.rfc-chip').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.cluster as ChipKey | undefined;
      if (key) renderForecastChipDetail(key);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const key = el.dataset.cluster as ChipKey | undefined;
        if (key) renderForecastChipDetail(key);
      }
    });
  });
}
