/**
 * HYROX forecast-fingerprint chip detail pages.
 *
 * Tapping a factor chip (You / Run pace / Stations / Training / Venue) on the
 * HYROX forecast hero navigates here. Each page leads with the headline
 * number, follows with the breakdown that drives it, then a short caption
 * explaining the science. Mirrors `forecast-chip-detail-view.ts` (marathon
 * mode) for visual and structural parity. The only thing that changes is
 * the HYROX-specific data each page reads.
 *
 * Back button returns to the HYROX forecast view.
 */

import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import type { SimulatorState } from '@/types/state';
import { renderTabBar, wireTabBarHandlers, type TabId } from '@/ui/tab-bar';
import { atmosphereGradient, buildSunGlint, buildRingBackground } from '@/ui/page-flair';
import { predictHyroxRace, type HyroxStationLine } from '@/calculations/race-prediction.hyrox';
import { deriveHyroxRunPace } from '@/calculations/hyrox-run-pace';
import { getHyroxVenueById, rescaleTimeAcrossVenues } from '@/data/hyrox-venues';
import { getHyroxEventById, getVenueIdForEvent, getFutureHyroxEvents, HYROX_WORLD_SERIES } from '@/data/hyrox-events';
import { STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { HYROX_TIME_TO_BAND_THRESHOLDS } from '@/constants/hyrox-constants';
import {
  latestTestAgeMonths,
  bestStationTime,
  getStationHistory,
  latestImprovementSec,
} from '@/calculations/hyrox-station-history';
import { buildBenchmarkTrendChart } from '@/ui/triathlon/benchmark-charts';
import { fp, fmtModelPaceKm } from '@/utils/format';
import { classifyHyroxSessionKind, type HyroxSessionKind } from '@/calculations/hyrox-session-classifier';
import type { Workout } from '@/types/state';
import {
  computeSportMix,
  collapseTopN,
  buildSportDonut as buildSportDonutShared,
  buildSportLegend as buildSportLegendShared,
} from '@/ui/sport-mix-donut';
import { isHyroxEasyErg } from '@/workouts/hyrox-easy-erg';

export type HyroxChipKey = 'you' | 'runpace' | 'stations' | 'training' | 'venue';

// ── Design tokens (mirror forecast-chip-detail-view.ts) ──────────────────────

const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const TEXT_L = '#94A3B8';
const CARD = 'background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px 20px';

// ── Shared helpers ───────────────────────────────────────────────────────────

function escapeText(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtMmSs(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** HYROX run paces (LT-derived, can be fractional): the whole second with
 *  the minute carried (fmtModelPaceKm), never "4:60/km". */
function fmtPace(secPerKm: number): string {
  return `${fmtModelPaceKm(secPerKm)}/km`;
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

// ── Per-chip page bodies ─────────────────────────────────────────────────────

const HX_SPORT_MIX_TOKENS = { textM: TEXT_M, textS: TEXT_S, textL: TEXT_L, accent: '#3B82F6' };
const buildSportDonut = (slices: Parameters<typeof buildSportDonutShared>[0], totalWeeklyTSS: number) =>
  buildSportDonutShared(slices, totalWeeklyTSS, HX_SPORT_MIX_TOKENS);
const buildSportLegend = (slices: Parameters<typeof buildSportLegendShared>[0]) =>
  buildSportLegendShared(slices, HX_SPORT_MIX_TOKENS);

function pageYou(s: SimulatorState): { title: string; subhead: string; body: string } {
  const hx = s.hyroxConfig;
  const band = hx?.athleteBand;
  const bandLabel = band ? band[0].toUpperCase() + band.slice(1) : 'Not set';
  const prevSec = hx?.previousHyroxTimeSec;
  const prevRaceId = hx?.hyroxPreviousTimeRaceId;
  const prevEvent = prevRaceId ? getHyroxEventById(prevRaceId) : undefined;
  const prevFmtLabel = (() => {
    switch (hx?.hyroxPreviousTimeFormat) {
      case 'open_singles': return 'Open Singles';
      case 'open_doubles': return 'Open Doubles';
      case 'pro_singles':  return 'Pro Singles';
      case 'pro_doubles':  return 'Pro Doubles';
      default: return '—';
    }
  })();

  // ── Athlete profile (lifted from running/tri pageYou) ──────────────────────
  // Same signals the other modes show, tier from CTL+VDOT, CTL itself, age, // so the user sees the historic-training context HYROX otherwise hides.
  const tier = s.athleteTier;
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1).replace('_', '-') : 'Not classified';
  const ctl = Math.round(s.ctlBaseline ?? 0);
  const age = s.onboarding?.age;
  const metaParts: string[] = [`${escapeText(tierLabel)} tier`];
  if (ctl > 0) metaParts.push(`CTL ${ctl}`);
  if (typeof age === 'number' && age > 0) metaParts.push(`${age} yrs`);
  const profileCard = (ctl > 0 || tier) ? `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:14px;color:${TEXT_S};font-weight:500">Athlete profile</span>
        <span style="font-size:12px;color:${TEXT_L}">From your training</span>
      </div>
      <div style="font-size:13px;color:${TEXT_M}">${metaParts.join(' · ')}</div>
    </div>
  ` : '';

  // ── Training mix (shared module) ──────────────────────────────────────────
  const { slices: rawSlices, totalWeeklyTSS } = computeSportMix(s);
  const slices = collapseTopN(rawSlices, 3);
  const totalSessionsPerWeek = rawSlices.reduce((sum, slice) => sum + slice.sessionsPerWeek, 0);
  const sportMixCard = slices.length > 0 ? `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:14px;color:${TEXT_S};font-weight:500">Training mix</span>
        <span style="font-size:11px;color:${TEXT_L}">8-week Strava history</span>
      </div>
      ${buildSportDonut(slices, totalWeeklyTSS)}
      ${buildSportLegend(slices)}
    </div>
  ` : '';

  // ── Recent volume ─────────────────────────────────────────────────────────
  const weeklyKm = s.detectedWeeklyKm ?? 0;
  const unitPref = s.unitPref ?? 'km';
  const fmtKmRow = (km: number) => unitPref === 'mi' ? `${(km * 0.621371).toFixed(1)} mi/wk` : `${km.toFixed(1)} km/wk`;
  const volumeRows: string[] = [];
  if (weeklyKm > 0) volumeRows.push(statRow('Running', fmtKmRow(weeklyKm)));
  if (totalSessionsPerWeek > 0) volumeRows.push(statRow('All sports', `${totalSessionsPerWeek.toFixed(1).replace(/\.0$/, '')} sessions/wk`));
  if (totalWeeklyTSS > 0) volumeRows.push(statRow('Weekly load', `${Math.round(totalWeeklyTSS)} TSS`));
  const volumeCard = volumeRows.length > 0 ? `
    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:6px">Recent volume</div>
      ${volumeRows.join('')}
    </div>
  ` : '';

  // ── Calibration push ──────────────────────────────────────────────────────
  // Two paths: log a previous HYROX time (anchors the band), or test stations
  // (anchors per-station seeds). When neither is set the prediction leans on
  // the experience-level fallback only. We surface the asks prominently.
  const stationsSingles = hx?.stationBenchmarksSingles ?? {};
  const stationsDoubles = hx?.stationBenchmarksDoubles ?? {};
  const stationsLegacy = hx?.stationBenchmarks ?? {};
  const calibratedStationCount =
    Object.keys(stationsSingles).length +
    Object.keys(stationsDoubles).length +
    Object.keys(stationsLegacy).length;
  const sparseStations = calibratedStationCount < 4;

  const calibrationCard = (!prevSec || sparseStations) ? `
    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_M};font-weight:600;margin-bottom:6px">Sharpen the prediction</div>
      <div style="font-size:13px;color:${TEXT_S};line-height:1.55;margin-bottom:14px">${
        !prevSec && sparseStations
          ? 'Two ways to anchor the model to your actual capacity: a previous HYROX time and per-station benchmarks. Without either, the band falls back to your onboarding experience level.'
          : !prevSec
            ? 'A previous HYROX time anchors your band. Without one, the band falls back to your onboarding experience level.'
            : `Only ${calibratedStationCount} station${calibratedStationCount === 1 ? '' : 's'} tested. Each tested station replaces a seed estimate with your actual capacity.`
      }</div>
      ${!prevSec ? `
        <button id="hx-cd-log-prev" class="m-btn-secondary" style="display:block;width:100%;padding:11px;font-size:14px;margin-bottom:8px">Log a previous HYROX time</button>
      ` : ''}
      ${sparseStations ? `
        <button id="hx-cd-test-stations" class="m-btn-secondary" style="display:block;width:100%;padding:11px;font-size:13px">Test station benchmarks</button>
      ` : ''}
    </div>
  ` : '';

  const prevCard = prevSec
    ? `
      <div style="${CARD};margin-bottom:14px">
        <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:6px">Previous HYROX</div>
        <div style="font-size:24px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em;font-variant-numeric:tabular-nums">${fmtMmSs(prevSec)}</div>
        <div style="font-size:13px;color:${TEXT_S};margin-top:4px">${prevFmtLabel}${prevEvent ? ` · ${escapeText(prevEvent.city)}` : ''}</div>
        <button id="hx-cd-prev-format" class="m-btn-secondary" style="margin-top:12px;padding:8px 12px;font-size:12px">Change format</button>
      </div>
    `
    : '';

  // Band thresholds rendered as a stat list. The currently-active band is
  // highlighted so the user sees where they sit.
  const bandRows = HYROX_TIME_TO_BAND_THRESHOLDS.map((t, i) => {
    const prevMax = i > 0 ? HYROX_TIME_TO_BAND_THRESHOLDS[i - 1].maxSec : 0;
    const rangeLabel = t.maxSec === Infinity
      ? `${fmtMmSs(prevMax)}+`
      : i === 0
        ? `Under ${fmtMmSs(t.maxSec)}`
        : `${fmtMmSs(prevMax)} – ${fmtMmSs(t.maxSec)}`;
    const isActive = band === t.band;
    const tBand = t.band[0].toUpperCase() + t.band.slice(1);
    return `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.04);${isActive ? 'background:rgba(15,23,42,0.04);margin:0 -20px;padding-left:20px;padding-right:20px' : ''}">
        <span style="color:${isActive ? TEXT_M : TEXT_S};font-weight:${isActive ? 600 : 400}">${tBand}${isActive ? ' · You' : ''}</span>
        <span style="color:${isActive ? TEXT_M : TEXT_S};font-variant-numeric:tabular-nums">${rangeLabel}</span>
      </div>
    `;
  }).join('');

  // Band source: from a logged race (high confidence) vs from onboarding
  // self-report (fallback). The label scope and visual prominence change
  // so the user knows when the band is the strongest signal vs the weakest.
  const bandFromRace = !!prevSec;
  const bandSourceCaption = bandFromRace
    ? 'Derived from your previous HYROX time'
    : 'Fallback from onboarding self-report. Log a previous time to anchor properly';
  const bandValueColor = bandFromRace ? TEXT_M : TEXT_S;
  const bandValueSize = bandFromRace ? '28px' : '22px';
  const bandValueWeight = bandFromRace ? '600' : '500';

  const body = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:14px;color:${TEXT_S};font-weight:500">HYROX band</span>
        <span style="font-size:12px;color:${TEXT_L}">Anchors station seed times</span>
      </div>
      <div style="font-size:${bandValueSize};font-weight:${bandValueWeight};color:${bandValueColor};letter-spacing:-0.01em">${bandLabel}</div>
      <div style="font-size:12px;color:${TEXT_S};margin-top:6px;line-height:1.45">${bandSourceCaption}</div>
    </div>

    ${calibrationCard}
    ${prevCard}
    ${profileCard}
    ${sportMixCard}
    ${volumeCard}

    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:6px">Band thresholds</div>
      ${bandRows}
    </div>

    ${captionCard('HYROX band and training tier measure different things. The band is your HYROX race-time bracket. It sets the seed times Mosaic uses for stations you have not personally tested. Training tier is your general training-load level, derived from CTL and VDOT. A recreational tier can produce a beginner band (no HYROX history) just as easily as a well-trained tier can. The two will only align once you have a race time on file. Tested stations override the seed for that station only; the band still anchors the untested stations.')}
  `;

  return { title: 'You', subhead: 'Profile that anchors the prediction', body };
}

function pageRunPace(s: SimulatorState): { title: string; subhead: string; body: string } {
  const prediction = predictHyroxRace(s);
  if (!prediction) {
    return { title: 'Run pace', subhead: '', body: `<div style="${CARD};text-align:center;color:${TEXT_S};font-size:13px">No prediction available yet.</div>` };
  }
  const paceSecKm = Math.round(prediction.runSec / 8);
  const vdot = s.v ?? 0;
  const sourceCopy = prediction.runPaceSource === 'derived'
    ? `Updated from your VDOT (${vdot.toFixed(1)}). Recalculates from your runs as fitness changes.`
    : prediction.runPaceSource === 'seed'
    ? `Population average for the ${s.hyroxConfig?.athleteBand ?? 'current'} band. Sync a recent run and Mosaic anchors pace on your VDOT instead.`
    : 'Set manually during onboarding. Updates from runs when better data is available.';

  const vdotSamples = (s.vdotHistory ?? [])
    .filter(h => h.vdot && h.vdot > 0 && h.date)
    .map(h => ({ date: h.date!, value: h.vdot }));
  const vdotChart = vdotSamples.length >= 2
    ? buildBenchmarkTrendChart(vdotSamples, '#3B82F6', 'rgba(59,130,246,0.08)', '', false)
    : '';

  // ISSUE-274: the Daniels training-zone card (Easy/Marathon/Threshold/Interval/Rep
  // from s.pac) was running-mode content leaking into the HYROX run-pace detail.
  // HYROX coaching is built on Critical Pace, not marathon zones. The card was
  // removed; in its place the HYROX-native anchor (critical pace) is surfaced
  // here from the same canonical call the dedicated CP detail page uses, so the
  // numbers agree by construction.
  const cpComponents = deriveHyroxRunPace(s).components ?? null;
  const cpSecKm = cpComponents?.criticalPaceSecKm ?? null;
  const cpRow = cpSecKm != null
    ? statRow('Critical pace', fmtPace(Math.round(cpSecKm)))
    : '';
  const cpLink = cpSecKm != null
    ? `<button id="hx-cd-critical-pace" style="background:transparent;border:none;padding:10px 0 0;font-size:13px;color:${TEXT_S};cursor:pointer;font-family:var(--f)">View critical pace →</button>`
    : '';

  const body = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
        <div>
          <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Average pace · 8 × 1km</div>
          <div style="font-size:32px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${fmtPace(paceSecKm)}</div>
        </div>
        ${vdot > 0 ? `<div style="font-size:11px;color:${TEXT_L}">VDOT ${vdot.toFixed(1)}</div>` : ''}
      </div>
      ${vdotChart}
      ${statRow('Total run time', fmtMmSs(prediction.runSec))}
      ${cpRow}
      ${statRow('Source', prediction.runPaceSource === 'derived' ? 'Derived from VDOT' : prediction.runPaceSource === 'seed' ? 'Population avg' : 'Set manually')}
      ${cpLink}
    </div>


    ${captionCard(sourceCopy + ' Critical pace is the sustainable anchor behind this number: the speed you can hold across all eight 1km legs. Run pace is the largest single contributor to the predicted finish, so a recent run sharpens the headline number more than any single station test.')}
  `;

  return { title: 'Run pace', subhead: '1km loop pace under fatigue', body };
}

function pageStations(s: SimulatorState): { title: string; subhead: string; body: string } {
  const prediction = predictHyroxRace(s);
  if (!prediction) {
    return { title: 'Stations', subhead: '', body: `<div style="${CARD};text-align:center;color:${TEXT_S};font-size:13px">No prediction available yet.</div>` };
  }
  const total = prediction.stations.length;
  const calibrated = prediction.calibratedCount;
  const summedSec = prediction.stationsSec;
  const format = s.hyroxConfig?.format ?? 'open_singles';

  // Aggregate improvement across all tested stations (sum of latest-vs-previous
  // deltas where two same-format tests exist). Surfaces "you've trimmed 1:24
  // off your stations". A real-data summary that mirrors VDOT's delta.
  let totalImprovementSec = 0;
  let improvedCount = 0;
  for (const line of prediction.stations) {
    if (line.source !== 'calibrated') continue;
    const delta = latestImprovementSec(s, line.station, format);
    if (delta == null) continue;
    totalImprovementSec += delta;
    improvedCount += 1;
  }
  const hasImprovementSignal = improvedCount > 0;
  const improvementGood = totalImprovementSec < 0;

  const rows = prediction.stations.map((line: HyroxStationLine, i: number) => {
    const display = STATION_DISPLAY[line.station];
    const isCalibrated = line.source === 'calibrated';
    const ageMo = isCalibrated ? latestTestAgeMonths(s, line.station) : null;
    const ageCaption = ageMo != null && ageMo >= 4 ? ` · ${Math.round(ageMo)} mo ago` : '';
    const best = isCalibrated ? bestStationTime(s, line.station, format) : null;
    const hist = isCalibrated ? getStationHistory(s, line.station).filter(e => e.format === format) : [];
    const testCount = hist.length;
    const isPR = best != null && Math.abs(best.sec - line.baseSec) < 0.5 && testCount >= 2;
    const bestCaption = best != null && testCount >= 2 && best.sec < line.baseSec - 0.5
      ? ` · PR ${fmtMmSs(best.sec)}`
      : isPR
      ? ' · PR'
      : '';
    const testsCaption = testCount >= 2 ? ` · ${testCount} tests` : '';
    return `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:10px 0;font-size:13px;border-top:${i === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'}">
        <span style="display:flex;flex-direction:column;gap:2px">
          <span style="color:${TEXT_M}">${escapeText(display.name)}</span>
          <span style="font-size:11px;color:${isCalibrated ? '#1F7A3D' : TEXT_L}">${isCalibrated ? 'Tested' : 'Estimated'}${ageCaption}${bestCaption}${testsCaption}</span>
        </span>
        <span style="color:${TEXT_M};font-variant-numeric:tabular-nums">${fmtMmSs(line.baseSec)}</span>
      </div>
    `;
  }).join('');

  // Calibration progress bar. Visual analogue to a trend chart for the
  // "calibrated X/8" headline.
  const calibPct = total > 0 ? (calibrated / total) * 100 : 0;
  const calibBar = `
    <div style="margin-top:10px;height:6px;background:#E2E8F0;border-radius:3px;overflow:hidden">
      <div style="height:100%;width:${calibPct.toFixed(1)}%;background:#1F7A3D;border-radius:3px"></div>
    </div>
  `;

  const improvementRow = hasImprovementSignal
    ? `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding-top:10px;margin-top:10px;border-top:1px solid rgba(0,0,0,0.05);font-size:12px">
        <span style="color:${TEXT_S}">Across ${improvedCount} re-tested station${improvedCount === 1 ? '' : 's'}</span>
        <span style="color:${improvementGood ? '#34C759' : '#FF3B30'};font-variant-numeric:tabular-nums">${improvementGood ? '−' : '+'}${fmtMmSs(Math.abs(totalImprovementSec))}</span>
      </div>
    `
    : '';

  const body = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <div>
          <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Calibrated</div>
          <div style="font-size:32px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${calibrated}/${total}</div>
        </div>
        <div style="font-size:11px;color:${TEXT_L}">${fmtMmSs(summedSec)} summed</div>
      </div>
      ${calibBar}
      ${improvementRow}
      <button id="hx-cd-test-stations" class="m-btn-primary" style="width:100%;margin-top:14px;padding:10px;font-size:13px">Test stations</button>
    </div>

    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:6px">Per-station breakdown</div>
      ${rows}
    </div>

    ${captionCard('Untested stations use population averages from the seed table for your band. Testing each station replaces the seed with your personal time. Mosaic doubles a half-distance test for the actual race-pace estimate. Calibrating all 8 takes the seed-data caveat off the prediction.')}
  `;

  return { title: 'Stations', subhead: 'Personal anchors vs population seeds', body };
}

function pageTraining(s: SimulatorState): { title: string; subhead: string; body: string } {
  const hx = s.hyroxConfig;
  const currentWeekIdx = s.w ?? 0;
  const totalWeeks = s.tw ?? 0;
  const weeksRemaining = Math.max(0, totalWeeks - currentWeekIdx - 1);
  const wks = s.wks ?? [];
  const currentWk = wks[currentWeekIdx];

  // Phase colours mirror the load-taper view so the chart reads consistent
  // across the app.
  const PHASE_COLORS: Record<string, string> = {
    base:  '#2563EB',
    build: '#EA580C',
    peak:  '#DC2626',
    taper: '#16A34A',
  };
  const phaseLabel = (ph: string | undefined): string => {
    if (!ph) return '—';
    return ph[0].toUpperCase() + ph.slice(1);
  };
  const currentPhase = currentWk?.ph as string | undefined;
  const currentPhaseLabel = phaseLabel(currentPhase);
  const currentPhaseColor = currentPhase ? PHASE_COLORS[currentPhase] ?? TEXT_M : TEXT_M;

  // Count completed sessions per week from `garminActuals` (the canonical
  // activity store for synced Strava + Garmin rows in HYROX mode). Past +
  // current weeks only. Future weeks aren't on the chart because they
  // haven't happened yet, so showing a planned bar there would be a made-up
  // number. The horizontal axis grows as the plan progresses.
  type WeekActuals = {
    idx: number;
    label: string;
    completed: number;
    kinds: Record<HyroxSessionKind, number>;
    phase: string | undefined;
    phaseColor: string;
    isCurrent: boolean;
  };
  const completedWeeks: WeekActuals[] = [];
  for (let i = 0; i <= currentWeekIdx && i < wks.length; i++) {
    const wk = wks[i];
    const ph = wk?.ph as string | undefined;
    const actuals = (wk?.garminActuals ?? {}) as Record<string, unknown>;
    const planned = (wk?.triWorkouts ?? []) as Workout[];
    const seen = new Set<string>();
    const kinds: Record<HyroxSessionKind, number> = { run: 0, station: 0, brick: 0, other: 0 };
    let completed = 0;
    for (const actual of Object.values(actuals)) {
      if (!actual) continue;
      const id = (actual as { garminId?: string }).garminId;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const durSec = ((actual as { durationSec?: number }).durationSec) ?? 0;
      if (durSec < 60) continue;
      const matched = id
        ? planned.find(w => (w as { matchedActivityId?: string }).matchedActivityId === id) ?? null
        : null;
      const kind = classifyHyroxSessionKind(actual, matched);
      kinds[kind] += 1;
      completed += 1;
    }
    completedWeeks.push({
      idx: i,
      label: `${i + 1}`,
      completed,
      kinds,
      phase: ph,
      phaseColor: ph ? PHASE_COLORS[ph] ?? '#94A3B8' : '#94A3B8',
      isCurrent: i === currentWeekIdx,
    });
  }

  const maxCompleted = Math.max(1, ...completedWeeks.map(b => b.completed));
  const totalCompleted = completedWeeks.reduce((sum, b) => sum + b.completed, 0);
  // Auto-thin x-axis labels when the plan is long.
  const labelEvery = completedWeeks.length > 14 ? 3 : completedWeeks.length > 8 ? 2 : 1;
  const chartCard = completedWeeks.length === 0
    ? `<div style="text-align:center;padding:18px 8px;font-size:12px;color:${TEXT_S}">Sync your first activity to see your weekly completion.</div>`
    : totalCompleted === 0
    ? `<div style="text-align:center;padding:18px 8px;font-size:12px;color:${TEXT_S}">Nothing logged yet this plan. The chart fills as activities sync.</div>`
    : `
      <div style="display:flex;align-items:flex-end;gap:4px;height:90px;padding:8px 4px 4px;position:relative">
        ${completedWeeks.map(b => {
          const hPct = b.completed === 0 ? 0 : (b.completed / maxCompleted) * 100;
          const ring = b.isCurrent ? `outline:2px solid ${TEXT_M};outline-offset:2px;` : '';
          const showLabel = (b.idx % labelEvery === 0) || b.isCurrent || b.idx === completedWeeks.length - 1;
          return `
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0">
              <div style="width:100%;background:${b.phaseColor};opacity:${b.isCurrent ? 1 : 0.7};border-radius:2px;height:${hPct === 0 ? 2 : Math.max(6, hPct)}%;transition:height 0.3s;${ring}${b.completed === 0 ? `background:${TEXT_L};opacity:0.25;` : ''}"></div>
              <span style="font-size:9px;color:${b.isCurrent ? TEXT_M : TEXT_L};line-height:1;font-weight:${b.isCurrent ? 600 : 400}">${showLabel ? b.label : ''}</span>
              ${b.completed > 0 ? `<span style="font-size:10px;color:${TEXT_M};font-variant-numeric:tabular-nums">${b.completed}</span>` : `<span style="font-size:10px;color:${TEXT_L}">·</span>`}
            </div>
          `;
        }).join('')}
      </div>
    `;

  // "This week's mix" reads completed activities only. No inventing station /
  // brick counts that the user hasn't actually done. Card hides entirely when
  // the current week has zero completed sessions.
  const thisWeekKinds = completedWeeks[completedWeeks.length - 1]?.kinds
    ?? { run: 0, station: 0, brick: 0, other: 0 };
  const thisWeekCompleted = completedWeeks[completedWeeks.length - 1]?.completed ?? 0;
  const mixRow = (label: string, n: number, color: string): string => {
    if (n === 0) return '';
    const pct = thisWeekCompleted > 0 ? (n / thisWeekCompleted) * 100 : 0;
    return `
      <div style="padding:9px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.04)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
          <span style="color:${TEXT_S}">${escapeText(label)}</span>
          <span style="color:${TEXT_M};font-variant-numeric:tabular-nums">${n}</span>
        </div>
        <div style="height:4px;background:#E2E8F0;border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${pct.toFixed(1)}%;background:${color};border-radius:2px"></div>
        </div>
      </div>
    `;
  };

  // Forward-looking "sessions ahead" counts read from the plan, since they
  // describe what's still to do. Counts the current week's remaining slots
  // (planned minus completed) plus all future weeks' full plans.
  const currentPlanned = (currentWk?.triWorkouts ?? []).filter(w => w != null).length;
  const currentRemaining = Math.max(0, currentPlanned - thisWeekCompleted);
  let futureSlots = 0;
  let futureRuns = 0;
  let futureStations = 0;
  let futureBricks = 0;
  for (let i = currentWeekIdx + 1; i < wks.length; i++) {
    const wk = wks[i];
    if (!wk?.triWorkouts) continue;
    for (const w of wk.triWorkouts) {
      if (!w) continue;
      futureSlots += 1;
      const disc = (w as { discipline?: string }).discipline;
      if (disc === 'run') futureRuns += 1;
      // Easy erg work is not a station session (discipline 'erg'; the type
      // check covers plans stored with the old 'station' value).
      else if (disc === 'station' && !isHyroxEasyErg(w)) futureStations += 1;
      else if (disc === 'brick') futureBricks += 1;
    }
  }
  const sessionsAhead = currentRemaining + futureSlots;

  const mtlCTL = hx && 'mtlCTL' in hx ? (hx as { mtlCTL?: number }).mtlCTL : undefined;
  const mtlATL = hx && 'mtlATL' in hx ? (hx as { mtlATL?: number }).mtlATL : undefined;
  const hasMtl = (mtlCTL != null && mtlCTL > 0) || (mtlATL != null && mtlATL > 0);

  const body = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
        <div>
          <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Phase</div>
          <div style="font-size:28px;font-weight:600;color:${currentPhaseColor};letter-spacing:-0.01em">${escapeText(currentPhaseLabel)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:${TEXT_L}">Week ${currentWeekIdx + 1} of ${totalWeeks || '—'}</div>
          ${weeksRemaining > 0 ? `<div style="font-size:11px;color:${TEXT_L};margin-top:2px">${weeksRemaining} weeks to go</div>` : ''}
        </div>
      </div>
      <div style="font-size:11px;color:${TEXT_S};margin-bottom:4px">Sessions completed by week</div>
      ${chartCard}
    </div>

    ${thisWeekCompleted > 0 ? `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="font-size:14px;color:${TEXT_S};font-weight:500">This week's mix</span>
          <span style="font-size:11px;color:${TEXT_L}">${thisWeekCompleted} done</span>
        </div>
        ${mixRow('Runs', thisWeekKinds.run, '#3B82F6')}
        ${mixRow('Stations', thisWeekKinds.station, '#EA580C')}
        ${mixRow('Bricks', thisWeekKinds.brick, '#DC2626')}
        ${mixRow('Other', thisWeekKinds.other, '#94A3B8')}
      </div>
    ` : ''}

    <div style="${CARD};margin-bottom:14px">
      ${statRow('Sessions ahead', `${sessionsAhead}`)}
      ${futureRuns > 0 ? statRow('Runs ahead', `${futureRuns}`) : ''}
      ${futureStations > 0 ? statRow('Stations ahead', `${futureStations}`) : ''}
      ${futureBricks > 0 ? statRow('Bricks ahead', `${futureBricks}`) : ''}
      ${statRow('Plan duration', `${totalWeeks || '—'} weeks`)}
      ${hasMtl && mtlCTL != null ? statRow('MTL fitness', mtlCTL.toFixed(0)) : ''}
      ${hasMtl && mtlATL != null ? statRow('MTL fatigue', mtlATL.toFixed(0)) : ''}
    </div>

    ${captionCard('Plan phase shapes the projection. Base builds aerobic capacity at easy effort, Build adds tempo and density, Peak introduces race-pace intervals, Taper drops volume 30 to 50% while holding intensity to clear fatigue. The horizon model assumes you complete the prescribed sessions. Fewer sessions per week trims the projected gain.')}
  `;

  return { title: 'Training', subhead: 'Phase and cadence driving the gain', body };
}

function pageVenue(s: SimulatorState): { title: string; subhead: string; body: string } {
  const hx = s.hyroxConfig;
  const prediction = predictHyroxRace(s);
  if (!prediction) {
    return { title: 'Venue', subhead: '', body: `<div style="${CARD};text-align:center;color:${TEXT_S};font-size:13px">No prediction available yet.</div>` };
  }
  const venue = hx?.venueId ? getHyroxVenueById(hx.venueId) : undefined;

  if (!venue) {
    return {
      title: 'Venue',
      subhead: 'No race picked yet',
      body: `
        <div style="${CARD};margin-bottom:14px;text-align:center">
          <div style="font-size:14px;color:${TEXT_M};line-height:1.5;margin-bottom:6px">Pick your race</div>
          <div style="font-size:12px;color:${TEXT_S};margin-bottom:14px">Mosaic builds your plan around the race date and applies floor surface, run-loop geometry, temperature, and altitude adjustments to the prediction.</div>
          <button id="hx-cd-pick-race" class="m-btn-primary" style="width:100%;padding:10px;font-size:13px">Pick race</button>
        </div>
        ${captionCard('Course factors apply peer-reviewed estimates of time cost per condition: Minetti for elevation grade, Ely for heat, Bassett for altitude. Climate dominates at hot venues even when the course itself is flat.')}
      `,
    };
  }

  const rawForPct = Math.max(prediction.rawSec, 1);
  const totalDelta = prediction.totalSec - prediction.rawSec;
  const totalPct = (totalDelta / rawForPct) * 100;
  const totalSign = totalPct >= 0 ? '+' : '−';
  const slowerOrFaster = totalPct >= 0 ? 'slower' : 'faster';

  // Horizontal bar widths scale against the largest absolute factor. So the
  // dominant factor reads full-width and smaller ones read proportionally.
  // Avoids reaching for absolute % which collapses thin factors to invisibility.
  const factors = prediction.courseFactors ?? [];
  const maxAbsPct = Math.max(0.5, ...factors.map(f => Math.abs((f.deltaSec / rawForPct) * 100)));
  const factorRows = factors.map((f, i) => {
    const pct = (f.deltaSec / rawForPct) * 100;
    const isZero = Math.abs(pct) < 0.05;
    const sign = isZero ? '' : (pct > 0 ? '+' : '−');
    const pctText = isZero ? '0.0%' : `${sign}${Math.abs(pct).toFixed(1)}%`;
    const barPct = (Math.abs(pct) / maxAbsPct) * 100;
    const barColor = isZero ? 'rgba(0,0,0,0.10)' : (pct > 0 ? '#C9603F' : '#5A8050');
    return `
      <div style="padding:10px 0;font-size:12px;border-top:${i === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="color:${TEXT_M};font-weight:500">${escapeText(f.label)}</span>
          <span style="display:flex;gap:14px;align-items:baseline">
            <span style="color:${TEXT_S}">${escapeText(f.value)}</span>
            <span style="color:${TEXT_M};font-variant-numeric:tabular-nums;min-width:56px;text-align:right;font-weight:500">${pctText}</span>
          </span>
        </div>
        <div style="height:5px;background:#E2E8F0;border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${barPct.toFixed(1)}%;background:${barColor};border-radius:3px"></div>
        </div>
      </div>
    `;
  }).join('');

  // Cross-venue equivalent: prior race translated to this venue, when a
  // previous race at a different venue exists.
  const prevSec = hx?.previousHyroxTimeSec;
  const prevRaceId = hx?.hyroxPreviousTimeRaceId;
  const prevEvent = prevRaceId ? getHyroxEventById(prevRaceId) : undefined;
  const prevVenueId = prevRaceId ? getVenueIdForEvent(prevRaceId) : undefined;
  const equivalentRow = (prevEvent && prevSec && hx?.venueId && prevVenueId && prevVenueId !== hx.venueId)
    ? statRow(
        `${escapeText(prevEvent.city)} ${fmtMmSs(prevSec)} ≈ here`,
        fmtMmSs(rescaleTimeAcrossVenues(prevSec, prevVenueId, hx.venueId)),
      )
    : '';

  const body = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <div>
          <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">${escapeText(venue.city)}</div>
          ${venue.name ? `<div style="font-size:18px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em">${escapeText(venue.name)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:${TEXT_L}">Course factor</div>
          <div style="font-size:18px;font-weight:600;color:${TEXT_M};font-variant-numeric:tabular-nums">${totalSign}${Math.abs(totalPct).toFixed(1)}%</div>
        </div>
      </div>
      ${venue.notes ? `<div style="font-size:12px;color:${TEXT_S};line-height:1.5;margin-top:8px;font-style:italic">${escapeText(venue.notes)}</div>` : ''}
    </div>

    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:14px;color:${TEXT_S};font-weight:500">Factor breakdown</span>
        <span style="font-size:11px;color:${TEXT_L}">Athletes finish ${totalSign}${Math.abs(totalPct).toFixed(1)}% ${slowerOrFaster}</span>
      </div>
      ${factorRows}
    </div>

    <div style="${CARD};margin-bottom:14px">
      ${statRow('Raw fitness', fmtMmSs(prediction.rawSec))}
      ${statRow('Adjusted finish', fmtMmSs(prediction.totalSec))}
      ${equivalentRow}
    </div>

    <div style="margin-bottom:14px">
      <button id="hx-cd-pick-race" class="m-btn-secondary" style="width:100%;padding:11px;font-size:13px">Change race</button>
    </div>

    ${captionCard('Course factors apply peer-reviewed estimates of time cost per condition: Minetti for elevation grade, Ely for heat, Bassett for altitude. Climate dominates at hot venues even when the course itself is flat. The factor is applied to your raw fitness pace to get the adjusted finish on the hero.')}
  `;

  return { title: venue.city, subhead: 'Venue course adjustments', body };
}

function pageFor(key: HyroxChipKey, s: SimulatorState): { title: string; subhead: string; body: string } {
  switch (key) {
    case 'you':      return pageYou(s);
    case 'runpace':  return pageRunPace(s);
    case 'stations': return pageStations(s);
    case 'training': return pageTraining(s);
    case 'venue':    return pageVenue(s);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render the HYROX chip-detail page. Replaces app-root with the full page;
 * back button returns to the HYROX forecast view.
 */
export function renderHyroxChipDetail(key: HyroxChipKey): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const page = pageFor(key, s);

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  container.innerHTML = `
    <style>
      @keyframes hxcdFloatUp { from { opacity:0; } to { opacity:1; } }
      .hxcd-fade { opacity:0; animation:hxcdFloatUp 0.55s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="hxcd-view" class="safe-top-bleed" style="
      position:relative;min-height:100vh;background:${atmosphereGradient('sky')};
      font-family:var(--f);overflow-x:hidden;
    ">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxcd', { variant: 'whisper', palette: 'sky' })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <div class="hxcd-fade" style="animation-delay:0.02s;padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <button id="hxcd-back-btn" style="background:transparent;border:none;font-size:14px;color:${TEXT_S};cursor:pointer;padding:0;font-family:var(--f)">← Back</button>
          <button id="hxcd-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <div class="hxcd-fade" style="animation-delay:0.06s;text-align:center;padding:20px 20px 16px">
          <div style="font-size:11px;color:${TEXT_S};font-weight:500">Forecast factor</div>
          <div style="font-size:30px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;line-height:1.1;margin-top:6px">${escapeText(page.title)}</div>
          ${page.subhead ? `<div style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">${escapeText(page.subhead)}</div>` : ''}
        </div>

        <div class="hxcd-fade" style="animation-delay:0.12s;padding:0 16px">
          ${page.body}
        </div>

      </div>

      ${renderTabBar('forecast')}
    </div>
  `;

  document.getElementById('hxcd-back-btn')?.addEventListener('click', () => {
    import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
  });
  document.getElementById('hxcd-account-btn')?.addEventListener('click', () => {
    import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Per-chip CTAs.
  document.getElementById('hxcd-prev-format')?.addEventListener('click', () => {
    // Defer to the prev-format modal living on the forecast view. Round-trip
    // back to the forecast so the modal lands in its native context.
    import('./forecast-view').then(({ renderHyroxForecastView }) => {
      renderHyroxForecastView();
      // Trigger the change-format affordance after the view mounts.
      setTimeout(() => document.getElementById('hx-verify-prev-format')?.click(), 50);
    });
  });
  document.getElementById('hx-cd-prev-format')?.addEventListener('click', () => {
    document.getElementById('hxcd-prev-format')?.click();
  });
  document.getElementById('hx-cd-log-prev')?.addEventListener('click', () => {
    import('@/ui/hyrox/log-prev-time-modal').then(({ openHyroxLogPrevTimeModal }) => {
      openHyroxLogPrevTimeModal(() => renderHyroxChipDetail('you'));
    });
  });
  document.getElementById('hx-cd-test-stations')?.addEventListener('click', () => {
    const ms = getMutableState();
    if (ms.hyroxConfig && (ms.hyroxConfig as { dismissedBenchmarkCard?: boolean }).dismissedBenchmarkCard) {
      (ms.hyroxConfig as { dismissedBenchmarkCard?: boolean }).dismissedBenchmarkCard = false;
      saveState();
    }
    import('@/ui/hyrox/plan-view').then(({ renderHyroxPlanView }) => renderHyroxPlanView());
  });
  document.getElementById('hx-cd-pick-race')?.addEventListener('click', () => {
    openHyroxRacePickerModal();
  });
  document.getElementById('hx-cd-critical-pace')?.addEventListener('click', () => {
    import('./critical-pace-detail-view').then(({ renderHyroxCriticalPaceDetail }) =>
      renderHyroxCriticalPaceDetail({ onBack: () => renderHyroxChipDetail('runpace') }));
  });

  wireTabBarHandlers(navigateTab);
}

/** Race picker modal. Lists upcoming HYROX World Series events. Picking an
 *  event updates `onboarding.hyroxRaceEventId` / `customRaceDate` / `hyroxVenueId`
 *  in lockstep and re-runs `initializeHyroxSimulator` so the plan rebuilds
 *  around the new race date. Mirrors the wizard's race-pick step so the title
 *  bar, week counter, and venue all stay coherent.
 *
 *  Why a race picker rather than a venue picker: HYROX races run at specific
 *  venues, so picking "Stockholm" really means "I'm racing Stockholm". The
 *  raceEventId / date / plan must change too, not just the venue factor. */
function openHyroxRacePickerModal(): void {
  const ms = getMutableState();
  if (!ms.hyroxConfig || !ms.onboarding) return;
  const currentEventId = ms.hyroxConfig.raceEventId;
  const currentRaceDate = ms.hyroxConfig.raceDate ?? ms.onboarding.customRaceDate ?? undefined;

  const today = new Date().toISOString().slice(0, 10);
  const future = getFutureHyroxEvents(today);

  // Sort by date ascending. If the current race is in the past somehow, still
  // include it so the user can see what they had picked.
  const current = currentEventId ? HYROX_WORLD_SERIES.find(e => e.id === currentEventId) : undefined;
  const events = [...future];
  if (current && !events.some(e => e.id === current.id)) events.unshift(current);
  events.sort((a, b) => a.date.localeCompare(b.date));

  const fmtDate = (iso: string): string => {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const eventRow = (e: typeof HYROX_WORLD_SERIES[0]): string => {
    const isPicked = e.id === currentEventId;
    const venueId = getVenueIdForEvent(e.id);
    const venue = venueId ? getHyroxVenueById(venueId) : undefined;
    const tags: string[] = [];
    if (venue) {
      if (venue.tempTendency === 'hot' || venue.tempTendency === 'warm') tags.push(venue.tempTendency === 'hot' ? 'Hot' : 'Warm');
      if (venue.tempTendency === 'cool') tags.push('Cool');
      if (venue.altitudeM >= 500) tags.push(`${Math.round(venue.altitudeM)}m`);
      if (venue.lapDifficulty === 'hard') tags.push('Tight loop');
      if (venue.lapDifficulty === 'easy') tags.push('Fast loop');
    } else {
      tags.push('Course-neutral');
    }
    const tagHtml = tags.length > 0
      ? `<span style="font-size:11px;color:${TEXT_L}">${tags.join(' · ')}</span>`
      : '';
    return `
      <button data-event-id="${e.id}" class="hx-race-row" style="display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:100%;padding:11px 14px;border:1px solid ${isPicked ? 'var(--c-black)' : 'rgba(0,0,0,0.08)'};border-radius:10px;background:${isPicked ? 'rgba(15,23,42,0.04)' : 'transparent'};color:${TEXT_M};font-size:13px;cursor:pointer;text-align:left;font-family:inherit;margin-bottom:6px">
        <span style="display:flex;align-items:baseline;justify-content:space-between;width:100%;gap:8px">
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="font-weight:500">${escapeText(e.city)}</span><span style="color:${TEXT_S};margin-left:6px">${escapeText(e.country)}</span></span>
          <span style="font-size:11px;color:${TEXT_S};font-variant-numeric:tabular-nums;flex-shrink:0">${escapeText(fmtDate(e.date))}</span>
        </span>
        ${tagHtml ? `<span style="display:block">${tagHtml}</span>` : ''}
      </button>
    `;
  };

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.32);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';
  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" style="width:100%;max-width:440px;max-height:80vh;background:#FDFCF7;border-radius:18px;padding:22px 20px 18px;box-shadow:0 12px 40px rgba(0,0,0,0.18);display:flex;flex-direction:column">
      <div style="font-size:16px;font-weight:500;color:var(--c-black);margin-bottom:6px">Pick your race</div>
      <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:14px">Picking a different race rebuilds your plan around the new race date and updates the venue course factors. Your training history is preserved.</div>
      <div style="flex:1;overflow-y:auto;margin:0 -4px 14px;padding:0 4px">
        ${events.map(eventRow).join('')}
      </div>
      <div style="display:flex;gap:10px">
        <button id="hx-race-cancel" class="m-btn-secondary" style="flex:1;padding:11px;font-size:13px">Cancel</button>
        <button id="hx-race-save" class="m-btn-primary" style="flex:1;padding:11px;font-size:13px;opacity:0.5" disabled>Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let pickedEventId: string | undefined = currentEventId;
  const saveBtn = overlay.querySelector('#hx-race-save') as HTMLButtonElement;
  const refreshSave = () => {
    const dirty = pickedEventId != null && pickedEventId !== currentEventId;
    saveBtn.disabled = !dirty;
    saveBtn.style.opacity = dirty ? '1' : '0.5';
  };
  overlay.querySelectorAll<HTMLButtonElement>('[data-event-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      pickedEventId = btn.getAttribute('data-event-id') ?? undefined;
      overlay.querySelectorAll<HTMLButtonElement>('[data-event-id]').forEach(b => {
        const isPicked = b === btn;
        b.style.borderColor = isPicked ? 'var(--c-black)' : 'rgba(0,0,0,0.08)';
        b.style.background = isPicked ? 'rgba(15,23,42,0.04)' : 'transparent';
      });
      refreshSave();
    });
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#hx-race-cancel')?.addEventListener('click', () => overlay.remove());
  saveBtn.addEventListener('click', () => {
    if (pickedEventId == null || pickedEventId === currentEventId) { overlay.remove(); return; }
    const event = getHyroxEventById(pickedEventId);
    if (!event) { overlay.remove(); return; }
    const dateChanged = event.date !== currentRaceDate;
    const mut = getMutableState();
    if (!mut.hyroxConfig || !mut.onboarding) { overlay.remove(); return; }

    const newVenueId = getVenueIdForEvent(event.id);

    // Mirror the wizard's race-pick step: onboarding carries the source of truth
    // for race id / date / venue, and `initializeHyroxSimulator` re-runs the
    // full plan-generation pipeline (archive existing wks, rebuild, redistribute
    // matched activities). When only the venue mapping changes for the same date,
    // skip the rebuild. It's just a venue factor swap.
    mut.onboarding.hyroxRaceEventId = event.id;
    mut.onboarding.customRaceDate = event.date;
    mut.onboarding.hyroxVenueId = newVenueId;

    overlay.remove();

    if (dateChanged) {
      import('@/state/initialization.hyrox').then(({ initializeHyroxSimulator }) => {
        initializeHyroxSimulator(mut.onboarding!);
        import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
      });
    } else {
      mut.hyroxConfig.raceEventId = event.id;
      mut.hyroxConfig.venueId = newVenueId;
      saveState();
      import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
    }
  });
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('@/ui/home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('@/ui/hyrox/plan-view').then(m => m.renderHyroxPlanView());
  else if (tab === 'stats') import('@/ui/hyrox/stats-view').then(m => m.renderHyroxStatsView());
  else if (tab === 'forecast') import('./forecast-view').then(m => m.renderHyroxForecastView());
  else if (tab === 'account') import('@/ui/account-view').then(m => m.renderAccountView());
}
