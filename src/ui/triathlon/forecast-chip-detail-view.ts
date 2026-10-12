/**
 * Triathlon forecast chip detail pages.
 *
 * Tapping a chip on the tri forecast page opens a full-page detail view
 * with the chip's math factor explained. Current state, how it feeds the
 * prediction, and where the user can take action.
 *
 * One page per factor; see `race-forecast-fingerprint.ts` for the chip set.
 */

import { getState, getMutableState } from '@/state/store';
import { getTriDistanceLabel, RUN_FATIGUE_DISCOUNT } from '@/constants/triathlon-constants';
import { saveState } from '@/state/persistence';
import type { SimulatorState } from '@/types/state';
import type { TriRacePrediction, CourseFactorEntry } from '@/types/triathlon';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { atmosphereGradient, buildSunGlint, buildRingBackground } from '../page-flair';
import { buildBenchmarkTrendChart } from './benchmark-charts';
import { getTriathlonById } from '@/data/triathlons';
import {
  recentHoursByDiscipline,
  plannedBuildDoseByDiscipline,
  longestSessionByDiscipline,
} from '@/calculations/tri-volume-by-discipline';
import { computeTriDisciplineConfidence } from '@/calculations/tri-discipline-confidence';
import { pbAgeWeight, pbAgeYears } from '@/calculations/physiological-vdot';
import { DURABILITY_THRESHOLDS } from '@/calculations/durability-cap';
import { CLIMATE_ANCHOR_TEMP_C } from '@/constants/triathlon-course-factors';
import { ft, fp } from '@/utils/format';
import type { TriChipKey } from './race-forecast-fingerprint';
import { buildInfoIcon, mountInfoPopovers } from '../info-popover';
import {
  computeSportMix as computeSportMixShared,
  collapseTopN,
  buildSportDonut as buildSportDonutShared,
  buildSportLegend as buildSportLegendShared,
} from '../sport-mix-donut';

// ── Design tokens ────────────────────────────────────────────────────────────

const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const TEXT_L = '#94A3B8';
const CARD = 'background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px 20px';

// Discipline accents. Mirror DISCIPLINE_COLOURS (swim blue / bike red / run green).
const COL_SWIM = '#3B82F6';
const COL_BIKE = '#DC2626';
const COL_RUN  = '#16A34A';

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

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtMSS(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtCssPace(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${String(s).padStart(2, '0')}/100m`;
}

function fmtHours(sec: number): string {
  const h = sec / 3600;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.round(sec / 60)} min`;
}

function disciplineDot(accent: string): string {
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${accent}"></span>`;
}

// ── Sport-mix donut (shared module, tri-themed via COL_RUN accent) ───────────

const SPORT_MIX_TOKENS = { textM: TEXT_M, textS: TEXT_S, textL: TEXT_L, accent: COL_RUN };
const computeSportMix = computeSportMixShared;
const buildSportDonut = (slices: Parameters<typeof buildSportDonutShared>[0], totalWeeklyTSS: number) =>
  buildSportDonutShared(slices, totalWeeklyTSS, SPORT_MIX_TOKENS);
const buildSportLegend = (slices: Parameters<typeof buildSportLegendShared>[0]) =>
  buildSportLegendShared(slices, SPORT_MIX_TOKENS);

// ── Page builders ────────────────────────────────────────────────────────────

interface PageContent { title: string; subhead: string; body: string }

function pageYou(s: SimulatorState): PageContent {
  const tri = s.triConfig;
  const tier = s.athleteTier;
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1).replace('_', '-') : 'Not classified';
  const archetype = s.typ ?? null;
  const age = s.onboarding?.age;
  const ctl = Math.round(s.ctlBaseline ?? 0);

  // Years training. Only show when ≥ 0.5y AND the source date predates the
  // last ~6 months. `firstStravaActivityISO` is set once from the Strava API's
  // earliest-activity lookup; on accounts with shallow sync it can be very
  // recent, which reads as "0.2y training" and undersells real history.
  const iso = s.firstStravaActivityISO;
  const yrsTraining = iso
    ? (Date.now() - Date.parse(iso)) / (1000 * 60 * 60 * 24 * 365.25)
    : null;
  const stravaSinceLabel = (yrsTraining != null && yrsTraining >= 0.5)
    ? `Strava since ${new Date(iso!).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`
    : null;

  // Header chip mirrors the fingerprint headline (tier first). Drill-down adds
  // archetype + age + Strava-since as supporting context.
  const metaParts: string[] = [];
  if (archetype) metaParts.push(`${escapeText(archetype)} archetype`);
  if (ctl > 0) metaParts.push(`CTL ${ctl}`);
  if (typeof age === 'number' && age > 0) metaParts.push(`${age} yrs`);
  if (stravaSinceLabel) metaParts.push(stravaSinceLabel);

  const profileCard = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:14px;color:${TEXT_S};font-weight:500">Profile</span>
        <span style="font-size:12px;color:${TEXT_L}">Anchors the model</span>
      </div>
      <div style="font-size:26px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em;margin-bottom:6px">${escapeText(tierLabel)} tier</div>
      <div style="font-size:13px;color:${TEXT_S}">${metaParts.join(' · ')}</div>
    </div>
  `;

  const { slices: rawSlices, totalWeeklyTSS } = computeSportMix(s);
  const slices = collapseTopN(rawSlices, 3);
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

  const swimPbs = tri?.swim?.pbs ?? {};
  const runPbs = s.pbs ?? {};
  const swimRows = (
    [
      ['Swim 100m', swimPbs.m100],
      ['Swim 200m', swimPbs.m200],
      ['Swim 400m', swimPbs.m400],
      ['Swim 1500m', swimPbs.m1500],
    ] as Array<[string, number | undefined]>
  ).filter(([, v]) => typeof v === 'number' && v! > 0)
    .map(([k, v]) => statRow(k, fmtDuration(v!)));

  const runRows = (
    [
      ['Run 5K', runPbs.k5],
      ['Run 10K', runPbs.k10],
      ['Half marathon', runPbs.h],
      ['Marathon', runPbs.m],
    ] as Array<[string, number | undefined]>
  ).filter(([, v]) => typeof v === 'number' && v! > 0)
    .map(([k, v]) => statRow(k, fmtDuration(v!)));

  const bikeFtp = tri?.bike?.ftp;
  const bikeRow = typeof bikeFtp === 'number' && bikeFtp > 0
    ? statRow('Bike FTP', `${Math.round(bikeFtp)}W`)
    : '';

  const pbsHasAny = swimRows.length + runRows.length > 0 || !!bikeRow;
  const pbsCard = `
    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:10px">Personal bests</div>
      ${pbsHasAny ? [...swimRows, bikeRow, ...runRows].filter(Boolean).join('') : `<div style="font-size:13px;color:${TEXT_S};line-height:1.5;text-align:center;padding:6px 0">No PBs on file yet.</div>`}
    </div>
  `;

  const raceLog = tri?.raceLog ?? [];
  const racesCard = raceLog.length > 0 ? (() => {
    const recent = raceLog.slice(-3).reverse();
    return `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
          <span style="font-size:14px;color:${TEXT_S};font-weight:500">Race history</span>
          <span style="font-size:11px;color:${TEXT_L}">${raceLog.length} logged</span>
        </div>
        ${recent.map(r => {
          const gap = r.predictedTotalSec - r.actualTotalSec;
          const gapTxt = Math.abs(gap) < 60 ? 'on prediction' : (gap > 0 ? `beat by ${Math.round(gap / 60)} min` : `behind by ${Math.round(-gap / 60)} min`);
          const tone = Math.abs(gap) < 60 ? TEXT_S : (gap > 0 ? '#1F7A3D' : '#9A6A20');
          const distLabel = getTriDistanceLabel(r.distance);
          return `
            <div style="padding:9px 0;border-top:1px solid rgba(0,0,0,0.04);font-size:13px">
              <div style="display:flex;justify-content:space-between;align-items:baseline">
                <span style="color:${TEXT_M}">${distLabel}</span>
                <span style="color:${TEXT_M};font-variant-numeric:tabular-nums">${fmtDuration(r.actualTotalSec)}</span>
              </div>
              <div style="font-size:11px;color:${tone};margin-top:2px">${escapeText(gapTxt)}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  })() : '';

  return {
    title: 'You',
    subhead: 'PBs anchor the prediction',
    body: `
      ${profileCard}
      ${sportMixCard}
      ${pbsCard}
      ${racesCard}
      ${captionCard('PBs across swim, bike, and run anchor the prediction. The run leg blends every PB into a single race-time estimate via the same engine running mode uses, then projects forward by training response. Race history feeds calibration once you have two logged races. The training mix shows where your weekly load comes from across all sports.')}
    `,
  };
}

function pageCapacity(s: SimulatorState, p: TriRacePrediction | null): PageContent {
  const tri = s.triConfig;
  const css = tri?.swim?.cssSecPer100m;
  const ftp = tri?.bike?.ftp;
  const vdot = p?.projection?.runVdot?.current ?? s.v;

  const projection = p?.projection;
  const weeksRemaining = projection?.weeksRemaining ?? 0;

  const markerRow = (
    label: string,
    accent: string,
    current: number | null,
    projected: number | null,
    fmt: (v: number) => string,
    inverted: boolean,
  ): string => {
    if (current == null) {
      return `
        <div style="padding:12px 0;border-top:1px solid rgba(0,0,0,0.04)">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="display:flex;align-items:center;gap:8px;font-size:13px;color:${TEXT_M};font-weight:500">
              ${disciplineDot(accent)}${escapeText(label)}
            </span>
            <span style="font-size:11px;color:${TEXT_L}">No marker yet</span>
          </div>
        </div>
      `;
    }
    const minDelta = label === 'FTP' ? 2 : 0.5;
    const moved = projected != null && Math.abs(current - projected) >= minDelta;
    const improving = projected != null
      ? (inverted ? projected < current : projected > current)
      : false;
    const deltaTone = !moved ? TEXT_S : (improving ? '#1F7A3D' : '#9A6A20');
    return `
      <div style="padding:12px 0;border-top:1px solid rgba(0,0,0,0.04)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="display:flex;align-items:center;gap:8px;font-size:13px;color:${TEXT_M};font-weight:500">
            ${disciplineDot(accent)}${escapeText(label)}
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
        <span style="font-size:11px;color:${TEXT_L}">${weeksRemaining > 0 ? `${Math.max(1, Math.round(weeksRemaining))}w to race day` : 'Race date pending'}</span>
      </div>
      ${markerRow('CSS', COL_SWIM, css ?? null, projection?.swimCss?.projected ?? null, fmtCssPace, /*inverted*/ true)}
      ${markerRow('FTP', COL_BIKE, ftp ?? null, projection?.bikeFtp?.projected ?? null, (v) => `${Math.round(v)}W`, /*inverted*/ false)}
      ${markerRow('VDOT', COL_RUN, vdot ?? null, projection?.runVdot?.projected ?? null, (v) => v.toFixed(1), /*inverted*/ false)}
    </div>
  `;

  const cssHistory = (tri?.swim?.cssHistory ?? []).filter(h => h.value > 0).map(h => ({ date: h.date, value: h.value }));
  const ftpHistory = (tri?.bike?.ftpHistory ?? []).filter(h => h.value > 0).map(h => ({ date: h.date, value: h.value }));
  const vdotHistory = (s.vdotHistory ?? []).filter(h => h.vdot && h.vdot > 0 && h.date).map(h => ({ date: h.date!, value: h.vdot }));

  const sparkSection = (title: string, samples: { date: string; value: number }[], accent: string, fill: string, suffix: string, inverted: boolean): string => `
    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:13px;color:${TEXT_S};font-weight:500;margin-bottom:10px">${escapeText(title)}</div>
      ${buildBenchmarkTrendChart(samples, accent, fill, suffix, inverted)}
    </div>
  `;

  const sparkCss  = cssHistory.length >= 2  ? sparkSection('Swim CSS history',  cssHistory,  '#38BDF8', 'rgba(56,189,248,0.10)', '/100m', /*inv*/ true) : '';
  const sparkFtp  = ftpHistory.length >= 2  ? sparkSection('Bike FTP history',  ftpHistory,  '#F59E0B', 'rgba(245,158,11,0.10)',  'W',     /*inv*/ false) : '';
  const sparkVdot = vdotHistory.length >= 2 ? sparkSection('Run VDOT history',  vdotHistory, '#10B981', 'rgba(16,185,129,0.10)',  '',      /*inv*/ false) : '';

  return {
    title: 'Capacity',
    subhead: 'Fitness markers that set the pace floor',
    body: `
      ${markersCard}
      ${sparkCss}
      ${sparkFtp}
      ${sparkVdot}
      ${captionCard('CSS, FTP, and VDOT anchor each leg of the prediction. The horizon model projects each marker to race day based on weeks remaining, planned sessions per discipline, your ability band, and recent adherence. Markers without recent training get demoted so the projection does not overpromise gains.')}
    `,
  };
}

function pageAdaptation(_s: SimulatorState, p: TriRacePrediction | null): PageContent {
  const adaptation = p?.adaptation;
  if (!adaptation) {
    return {
      title: 'Adaptation',
      subhead: 'How fast you respond vs population average',
      body: `<div style="${CARD};text-align:center"><div style="font-size:13px;color:${TEXT_S};line-height:1.5">Log a few weeks of sessions for the signal to build.</div></div>`,
    };
  }

  const sig = adaptation.signals;

  // Popover bodies for jargon labels. Registered as we render so each id is
  // only stored once even though it appears in multiple discipline cards.
  const INFO = {
    pahr: {
      title: 'Pa:Hr decoupling',
      body: '<p style="margin:0 0 8px 0">How much heart rate drifts upward relative to pace during a long session. Less drift means better aerobic durability. Your engine holds the same output without HR creeping up.</p><p style="margin:0">The model fits a line over recent weeks: shrinking drift raises your adaptation ratio, growing drift tempers it.</p>',
    },
    hrAtPower: {
      title: 'HR at power',
      body: '<p style="margin:0 0 8px 0">Mean heart rate during tempo-intensity rides (80–95% of FTP, ≥30 min). Falling HR at the same power output means your aerobic engine is improving.</p><p style="margin:0">A downward slope over the last several weeks raises the bike adaptation ratio.</p>',
    },
    cssSd: {
      title: 'CSS pace stability',
      body: '<p style="margin:0 0 8px 0">Standard deviation of pace during threshold swims. Lower SD = more controlled, even pacing. A sign of swim economy improving.</p><p style="margin:0">Shrinking SD across recent threshold sessions raises the swim adaptation ratio.</p>',
    },
  };

  // Per-discipline weights. Must mirror tri-adaptation-ratio.ts.
  // Each discipline's ratio = 1 + Σ(weight × signal). Null signal = 0.
  // `missingReason` explains what unlocks the signal when it reads as null.
  const disciplineConfig = [
    {
      key: 'swim' as const, label: 'Swim', accent: COL_SWIM, ratio: adaptation.swim,
      signals: [
        { name: 'HRV trend',          weight: 0.30, value: sig.hrv,     missingReason: 'Connect a watch with HRV. Needs 28 days of nightly data.' },
        { name: 'RPE vs expected',    weight: 0.50, value: sig.rpeSwim, missingReason: 'Rate 2+ tri swim sessions on the activity detail page.' },
        { name: 'CSS pace stability', weight: 0.20, value: sig.cssSd,   missingReason: 'Needs threshold swims with per-length splits across 3+ weeks.', infoKey: 'cssSd' },
      ],
    },
    {
      key: 'bike' as const, label: 'Bike', accent: COL_BIKE, ratio: adaptation.bike,
      signals: [
        { name: 'HRV trend',          weight: 0.25, value: sig.hrv,       missingReason: 'Connect a watch with HRV. Needs 28 days of nightly data.' },
        { name: 'RPE vs expected',    weight: 0.30, value: sig.rpeBike,   missingReason: 'Rate 2+ tri bike sessions on the activity detail page.' },
        { name: 'HR at power',        weight: 0.25, value: sig.hrAtPower, missingReason: 'Needs ≥3 tempo rides (80–95% FTP, ≥30 min) with HR + power.', infoKey: 'hrAtPower' },
        { name: 'Pa:Hr decoupling',   weight: 0.20, value: sig.pahrBike,  missingReason: 'Needs ≥3 rides ≥45 min with HR data across recent weeks.', infoKey: 'pahr' },
      ],
    },
    {
      key: 'run' as const, label: 'Run', accent: COL_RUN, ratio: adaptation.run,
      signals: [
        { name: 'HRV trend',          weight: 0.25, value: sig.hrv,      missingReason: 'Connect a watch with HRV. Needs 28 days of nightly data.' },
        { name: 'RPE vs expected',    weight: 0.30, value: sig.rpeRun,   missingReason: 'Rate 2+ tri run sessions on the activity detail page.' },
        { name: 'Pa:Hr decoupling',   weight: 0.45, value: sig.pahrRun,  missingReason: 'Needs ≥3 runs ≥45 min with HR data across recent weeks.', infoKey: 'pahr' },
      ],
    },
  ];

  const disciplineCard = (cfg: typeof disciplineConfig[number]): string => {
    const ratio = cfg.ratio;
    const clamped = Math.max(0.7, Math.min(1.3, ratio));
    const pct = ((clamped - 0.7) / 0.6) * 100;
    const tone = ratio >= 1.05 ? '#16A34A' : ratio <= 0.95 ? '#D97706' : TEXT_S;

    // Per-signal contribution rows. Show populated signals with their numeric
    // contribution; null signals get a "no signal" tag plus a one-line reason
    // explaining what unlocks them. Jargon labels (Pa:Hr decoupling, HR at
    // power, CSS pace stability) carry a `(?)` info icon that opens a popover.
    const sigRows = cfg.signals.map(sig => {
      const populated = sig.value != null;
      const contribution = populated ? sig.weight * sig.value! : 0;
      const contribSign = contribution >= 0 ? '+' : '';
      const contribColor = !populated ? TEXT_L
        : Math.abs(contribution) < 0.005 ? TEXT_S
        : contribution > 0 ? '#1F7A3D' : '#9A6A20';
      const valueDisplay = populated
        ? `${contribSign}${contribution.toFixed(3)}`
        : `<span style="font-style:italic">no signal</span>`;
      const infoIcon = (sig as { infoKey?: keyof typeof INFO }).infoKey
        ? buildInfoIcon(
            `tri-adapt-${(sig as { infoKey: keyof typeof INFO }).infoKey}`,
            INFO[(sig as { infoKey: keyof typeof INFO }).infoKey].title,
            INFO[(sig as { infoKey: keyof typeof INFO }).infoKey].body,
          )
        : '';
      const reasonLine = !populated
        ? `<div style="font-size:11px;color:${TEXT_L};line-height:1.4;margin-top:2px">${escapeText(sig.missingReason)}</div>`
        : '';
      return `
        <div style="padding:8px 0;font-size:12px;border-top:1px solid rgba(0,0,0,0.04)">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="color:${populated ? TEXT_M : TEXT_L}">${escapeText(sig.name)}${infoIcon} <span style="color:${TEXT_L};font-size:11px">(${(sig.weight * 100).toFixed(0)}%)</span></span>
            <span style="color:${contribColor};font-variant-numeric:tabular-nums">${valueDisplay}</span>
          </div>
          ${reasonLine}
        </div>
      `;
    }).join('');

    return `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <span style="display:flex;align-items:center;gap:8px;font-size:14px;color:${TEXT_M};font-weight:600">
            ${disciplineDot(cfg.accent)}${escapeText(cfg.label)}
          </span>
          <span style="font-size:18px;font-weight:600;color:${tone};font-variant-numeric:tabular-nums">${ratio.toFixed(2)}</span>
        </div>
        <div style="position:relative;height:6px;border-radius:3px;background:rgba(15,23,42,0.07);overflow:hidden;margin-bottom:10px">
          <div style="position:absolute;left:50%;top:0;height:100%;width:1px;background:rgba(15,23,42,0.20)"></div>
          <div style="position:absolute;left:0;top:0;height:100%;width:${pct.toFixed(1)}%;background:${tone};border-radius:3px"></div>
        </div>
        ${sigRows}
      </div>
    `;
  };

  return {
    title: 'Adaptation',
    subhead: 'How fast you respond vs population average',
    body: `
      ${disciplineConfig.map(disciplineCard).join('')}
      ${captionCard('Each discipline blends its own weighted set of signals into a ratio. 1.00 = on track. Above 1.05 the model credits faster horizon gains; below 0.95 it tempers them. Signals you have not yet generated count as 0. they neither help nor hurt, but the discipline only moves once at least one signal is present. HRV is the only cross-discipline signal; everything else is sport-specific.')}
    `,
  };
}

/** Recent distance per discipline (last `weeks` of synced actuals). All values
 *  in km; display layer converts swim to metres. The engine doesn't use these
 *  numbers for swim/bike (it reads hours), but Tristan prefers a distance-first
 *  display. This helper plus an average-pace conversion keeps the chip honest. */
function recentDistanceByDiscipline(s: SimulatorState, weeks: number): { swim: number; bike: number; run: number } {
  const out = { swim: 0, bike: 0, run: 0 };
  const nowMs = Date.now();
  const lookbackMs = weeks * 7 * 24 * 3600 * 1000;
  for (const wk of s.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const a of Object.values(wk.garminActuals)) {
      if (!a?.startTime || !a.activityType) continue;
      if (nowMs - Date.parse(a.startTime) > lookbackMs) continue;
      const km = a.distanceKm ?? 0;
      if (km <= 0) continue;
      const t = a.activityType.toUpperCase();
      if (t.includes('SWIM')) out.swim += km;
      else if (/RUN/.test(t)) out.run += km;
      else if (/RIDE|BIK|CYCLING/.test(t)) out.bike += km;
    }
  }
  return { swim: out.swim / weeks, bike: out.bike / weeks, run: out.run / weeks };
}

function pageTraining(s: SimulatorState, p: TriRacePrediction | null): PageContent {
  const phase = (s.wks ?? [])[(s.w ?? 1) - 1]?.ph ?? '—';
  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1);
  const currentWeek = Math.max(1, s.w ?? 1);
  const totalWeeks = s.tw ?? (s.wks?.length ?? 0);

  // Engine inputs the projection actually reads (sessions/wk → horizon model;
  // sessions + hours → readiness closure rate via geometric mean). These are
  // the build-dose average across remaining non-taper weeks — the same dose the
  // projection gains fitness at, not just the next 4 weeks.
  const buildDose = plannedBuildDoseByDiscipline(s);
  const planned = buildDose.sessions;
  const plannedHrs = buildDose.hours;

  // Recent actuals. Last 4 weeks of synced activity.
  const recentHrs = recentHoursByDiscipline(s, 4);
  const recentDist = recentDistanceByDiscipline(s, 4);
  const confidence = computeTriDisciplineConfidence(s, 12);

  // Convert planned hours → planned distance using each discipline's recent
  // average speed. When no recent activity exists, fall back to a typical
  // training pace (clearly captioned).
  const speed = {
    swim: recentHrs.swim > 0 ? recentDist.swim / recentHrs.swim : 2.4,   // km/h, ≈ 2:30/100m
    bike: recentHrs.bike > 0 ? recentDist.bike / recentHrs.bike : 28,    // km/h
    run:  recentHrs.run  > 0 ? recentDist.run  / recentHrs.run  : 9.5,   // km/h, ≈ 6:20/km
  };
  const plannedDist = {
    swim: plannedHrs.swim * speed.swim,
    bike: plannedHrs.bike * speed.bike,
    run:  plannedHrs.run  * speed.run,
  };

  // Engine-aligned km/wk for run (matches what readiness penalty reads).
  const readinessRunKm = p?.raceReadiness?.run?.weeklyVolumeActual ?? null;

  // Swim displays in metres; bike/run in km.
  const fmtDistSwim = (km: number): string => km > 0 ? `${Math.round(km * 1000).toLocaleString()} m` : '—';
  const fmtDistKm   = (km: number): string => km > 0 ? `${km < 10 ? km.toFixed(1) : Math.round(km).toString()} km` : '—';

  const totalSessions = planned.swim + planned.bike + planned.run;
  const totalPlannedKm = plannedDist.bike + plannedDist.run; // swim in metres, left out of summary

  const disciplineCard = (
    label: string,
    accent: string,
    plannedSess: number,
    plannedDistance: number,
    recentDistance: number,
    isSwim: boolean,
    weeksActive: number,
    runReadinessKm: number | null,
  ): string => {
    const fmt = isSwim ? fmtDistSwim : fmtDistKm;
    return `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
          <span style="display:flex;align-items:center;gap:8px;font-size:14px;color:${TEXT_M};font-weight:600">
            ${disciplineDot(accent)}${escapeText(label)}
          </span>
          <span style="font-size:11px;color:${TEXT_L}">${weeksActive > 0 ? `Active ${weeksActive}/12 recent weeks` : 'No recent activity'}</span>
        </div>
        ${statRow('Planned sessions / wk', plannedSess > 0 ? plannedSess.toFixed(1).replace(/\.0$/, '') : '—')}
        ${statRow('Planned distance / wk', fmt(plannedDistance))}
        ${statRow('Recent actual / wk',    fmt(recentDistance))}
        ${runReadinessKm != null && runReadinessKm > 0 ? statRow('Readiness reads', `${Math.round(runReadinessKm)} km/wk`) : ''}
      </div>
    `;
  };

  return {
    title: 'Training',
    subhead: 'Engine inputs from your plan',
    body: `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <div>
            <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Average build week</div>
            <div style="font-size:28px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">
              ${totalSessions > 0 ? `${totalSessions.toFixed(1).replace(/\.0$/, '')} <span style="font-size:14px;color:${TEXT_S};font-weight:500">sess/wk · ${Math.round(totalPlannedKm)} km bike+run</span>` : '—'}
            </div>
          </div>
          <div style="text-align:right;font-size:11px;color:${TEXT_L};line-height:1.5">${phaseLabel}<br/>Week ${currentWeek} of ${totalWeeks}</div>
        </div>
      </div>

      ${disciplineCard('Swim', COL_SWIM, planned.swim, plannedDist.swim, recentDist.swim, /*isSwim*/ true,  confidence.swim.weeksActive, null)}
      ${disciplineCard('Bike', COL_BIKE, planned.bike, plannedDist.bike, recentDist.bike, /*isSwim*/ false, confidence.bike.weeksActive, null)}
      ${disciplineCard('Run',  COL_RUN,  planned.run,  plannedDist.run,  recentDist.run,  /*isSwim*/ false, confidence.run.weeksActive, readinessRunKm)}

      ${captionCard('The horizon model projects fitness using your <strong>average build week</strong> per discipline (the dose drives the fitness gain). The race-readiness penalty closes at the rate of the plan\'s <strong>peak weeks</strong> (the sustained volume you reach approaching the race). Distances above are derived from planned hours times your recent pace per discipline (or a typical training pace when no recent activity exists), so the display reads in distance even though the engine works in sessions and hours. The Run card adds a fourth row showing the km/wk the readiness penalty reads directly from your last four weeks of synced runs.')}
    `,
  };
}

function pageEndurance(_s: SimulatorState, p: TriRacePrediction | null): PageContent {
  const r = p?.raceReadiness;
  if (!r) {
    return {
      title: 'Endurance',
      subhead: 'Endurance fit for the race distance',
      body: `<div style="${CARD};text-align:center"><div style="font-size:14px;color:${TEXT_M};line-height:1.5">Markers needed before endurance can be scored.</div></div>`,
    };
  }

  const overallTone = r.overallTone === 'ok' ? '#16A34A' : r.overallTone === 'caution' ? '#C48A3A' : '#D97706';
  const overallCard = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <div>
          <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Overall readiness</div>
          <div style="font-size:30px;font-weight:600;color:${overallTone};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${Math.round(r.overallScore)}</div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:2px">${escapeText(r.overallLabel)}</div>
        </div>
        <div style="text-align:right;font-size:11px;color:${TEXT_L};line-height:1.5">Today<br/>Per-discipline below</div>
      </div>
    </div>
  `;

  const disciplineCard = (
    label: string,
    accent: string,
    d: typeof r.swim,
  ): string => {
    const score = Math.round(d.score);
    const tone = d.tone === 'ok' ? '#16A34A' : d.tone === 'caution' ? '#C48A3A' : '#D97706';
    const volTxt = d.weeklyVolumeUnit === 'km'
      ? `${d.weeklyVolumeActual.toFixed(0)} / ${d.weeklyVolumeRequired.toFixed(0)} km/wk`
      : `${d.weeklyVolumeActual.toFixed(1)} / ${d.weeklyVolumeRequired.toFixed(1)} h/wk`;
    const longTxt = `${d.longestSessionActualHours.toFixed(1)} / ${d.longestSessionRequiredHours.toFixed(1)} h longest`;
    return `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
          <span style="display:flex;align-items:center;gap:8px;font-size:14px;color:${TEXT_M};font-weight:600">
            ${disciplineDot(accent)}${escapeText(label)}
          </span>
          <span style="font-size:18px;font-weight:600;color:${tone};font-variant-numeric:tabular-nums">${score} <span style="font-size:11px;color:${TEXT_L};font-weight:400">${escapeText(d.label)}</span></span>
        </div>
        <div style="position:relative;height:6px;border-radius:3px;background:rgba(15,23,42,0.07);overflow:hidden;margin-bottom:10px">
          <div style="position:absolute;left:0;top:0;height:100%;width:${score}%;background:${tone};border-radius:3px"></div>
        </div>
        ${statRow('Weekly volume', volTxt)}
        ${statRow('Longest session', longTxt)}
        ${statRow('Ability band', d.abilityBand.charAt(0).toUpperCase() + d.abilityBand.slice(1))}
        ${d.penaltyMultiplier > 1.001 ? statRow('Today penalty', `+${((d.penaltyMultiplier - 1) * 100).toFixed(1)}% on leg time`) : ''}
      </div>
    `;
  };

  return {
    title: 'Endurance',
    subhead: 'Endurance fit per discipline',
    body: `
      ${overallCard}
      ${disciplineCard('Swim', COL_SWIM, r.swim)}
      ${disciplineCard('Bike', COL_BIKE, r.bike)}
      ${disciplineCard('Run',  COL_RUN,  r.run)}
      ${captionCard('Readiness scores how well your recent volume and longest session match what the race distance demands. Each discipline is rated against per-band targets (your ability tier in that sport). Today is penalised when readiness is low; the projected race-day prediction credits the plan with closing the gap based on weeks remaining and planned sessions.')}
    `,
  };
}

function pageDurability(s: SimulatorState, p: TriRacePrediction | null): PageContent {
  const longest = longestSessionByDiscipline(s, 12);
  const distance = s.triConfig?.distance ?? '70.3';
  const rideTh = DURABILITY_THRESHOLDS[distance].longRideSec;
  const runTh  = DURABILITY_THRESHOLDS[distance].longRunSec;
  const bikePct = rideTh > 0 ? Math.min(100, (longest.bike / rideTh) * 100) : 0;
  const runPct  = runTh  > 0 ? Math.min(100, (longest.run  / runTh)  * 100) : 0;
  const limiting = p?.limitingFactor;

  const row = (label: string, accent: string, actualSec: number, thresholdSec: number, pct: number, capped: boolean): string => `
    <div style="padding:14px 0;border-top:1px solid rgba(0,0,0,0.04)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <span style="display:flex;align-items:center;gap:8px;font-size:14px;color:${TEXT_M};font-weight:600">
          ${disciplineDot(accent)}${escapeText(label)}
        </span>
        <span style="font-size:13px;color:${TEXT_M};font-variant-numeric:tabular-nums">${fmtHours(actualSec)} / ${fmtHours(thresholdSec)}</span>
      </div>
      <div style="position:relative;height:6px;border-radius:3px;background:rgba(15,23,42,0.07);overflow:hidden;margin-bottom:6px">
        <div style="position:absolute;left:0;top:0;height:100%;width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%;background:${capped ? '#C48A3A' : accent};border-radius:3px"></div>
      </div>
      <div style="font-size:11px;color:${TEXT_L}">${capped ? 'Currently capping the run leg' : pct >= 100 ? 'Threshold met' : `${(100 - pct).toFixed(0)}% headroom to threshold`}</div>
    </div>
  `;

  const cappedBanner = limiting ? `
    <div style="margin-bottom:14px;padding:12px 14px;border-radius:10px;background:rgba(196,138,58,0.10);font-size:13px;color:#6B5B2E;line-height:1.5">
      Today's prediction has the run leg capped by recent durability. The projection credits the plan's remaining long sessions toward closing the gap, so the race-day forecast is faster than today's.
    </div>
  ` : '';

  return {
    title: 'Durability',
    subhead: 'Long sessions vs race-distance threshold',
    body: `
      ${cappedBanner}
      <div style="${CARD};margin-bottom:14px">
        ${row('Long ride', COL_BIKE, longest.bike, rideTh, bikePct, limiting === 'long_ride_volume' || limiting === 'volume_durability')}
        ${row('Long run',  COL_RUN,  longest.run,  runTh,  runPct,  limiting === 'long_run_volume'   || limiting === 'volume_durability')}
        <div style="padding:14px 0;border-top:1px solid rgba(0,0,0,0.04)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <span style="display:flex;align-items:center;gap:8px;font-size:14px;color:${TEXT_M};font-weight:600">
              ${disciplineDot(COL_SWIM)}Long swim
            </span>
            <span style="font-size:13px;color:${TEXT_L};font-variant-numeric:tabular-nums">${longest.swim > 0 ? fmtHours(longest.swim) : '—'}</span>
          </div>
          <div style="font-size:11px;color:${TEXT_L};line-height:1.4">Not modelled. The engine applies no durability cap to the swim leg (Veiga 2013 finds the swim cap saturates well below race distance for trained athletes).</div>
        </div>
      </div>
      ${captionCard('Durability is an <strong>asymmetric cap</strong>: it can only slow you down, never speed you up. If either threshold is below race demand the engine multiplies the run leg upward. A 70.3 athlete who has never ridden more than 90 minutes loses time on the run from undertrained bike legs. Once both thresholds are met the multiplier is 1.0 and durability contributes nothing further to the prediction. That is intentional: the model rewards meeting the bar, not exceeding it. Beyond threshold, additional long-session volume shows up in <strong>Endurance</strong> (per-discipline readiness score) and in your VDOT / CSS / FTP via <strong>Capacity</strong>, not here.')}
    `,
  };
}

function pageBricks(s: SimulatorState): PageContent {
  // Same detection logic as the chip builder. Kept inline for transparency.
  type Brick = { dateISO: string; bikeMin: number; runMin: number; gapMin: number };
  const bricks: Brick[] = [];
  for (const wk of s.wks ?? []) {
    if (!wk?.garminActuals) continue;
    const actuals = Object.values(wk.garminActuals)
      .filter(a => a?.startTime && a.activityType)
      .sort((a, b) => Date.parse(a.startTime!) - Date.parse(b.startTime!));
    for (let i = 0; i < actuals.length - 1; i++) {
      const cur = actuals[i];
      const nxt = actuals[i + 1];
      const curIsBike = /ride|bik|cycling/i.test(cur.activityType ?? '');
      const nxtIsRun  = /run/i.test(nxt.activityType ?? '');
      if (!curIsBike || !nxtIsRun) continue;
      const curEnd = Date.parse(cur.startTime!) + (cur.durationSec ?? 0) * 1000;
      const nxtStart = Date.parse(nxt.startTime!);
      const gapMin = (nxtStart - curEnd) / 60000;
      if (gapMin < 0 || gapMin > 45) continue;
      bricks.push({
        dateISO: cur.startTime!,
        bikeMin: (cur.durationSec ?? 0) / 60,
        runMin: (nxt.durationSec ?? 0) / 60,
        gapMin,
      });
    }
  }
  bricks.sort((a, b) => Date.parse(b.dateISO) - Date.parse(a.dateISO));

  const recent = bricks.slice(0, 5);
  const count = bricks.length;
  const headline = count === 0 ? 'No bricks logged'
    : count <= 3 ? 'Building adaptation'
    : count <= 10 ? 'Adapting'
    : 'Adapted';

  // Engine: fatigue discount baseline by distance, modified by adaptation 0-1.
  const distance = s.triConfig?.distance ?? '70.3';
  // Per-distance fatigue discount (canonical table) — sprint 2% / olympic 4% / t100 5% / 70.3 5% / IM 11%.
  const baseFatigueDiscountPct = RUN_FATIGUE_DISCOUNT[distance] * 100;
  // Crude proxy: 12 bricks = fully adapted (matches engine half-saturation feel).
  const adaptScore = Math.min(1, count / 12);
  const reducedPct = baseFatigueDiscountPct * (1 - adaptScore * 0.4);

  const recentRows = recent.length === 0
    ? `<div style="font-size:13px;color:${TEXT_S};line-height:1.5;text-align:center;padding:6px 0">No brick-shape sessions detected (bike followed by run within 45 minutes).</div>`
    : recent.map(b => `
        <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.04)">
          <span style="color:${TEXT_M}">${new Date(b.dateISO).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          <span style="color:${TEXT_M};font-variant-numeric:tabular-nums">${Math.round(b.bikeMin)} min bike → ${Math.round(b.runMin)} min run</span>
        </div>
      `).join('');

  return {
    title: 'Bricks',
    subhead: 'Bike-to-run adaptation',
    body: `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div>
            <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">${escapeText(headline)}</div>
            <div style="font-size:28px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${count} <span style="font-size:14px;color:${TEXT_S};font-weight:500">bricks logged</span></div>
          </div>
          <div style="text-align:right;font-size:11px;color:${TEXT_L};line-height:1.5">
            Run fatigue discount<br/>
            <span style="color:${TEXT_M};font-weight:600;font-size:14px">${reducedPct.toFixed(1)}%</span><br/>
            (base ${baseFatigueDiscountPct}%)
          </div>
        </div>
      </div>
      <div style="${CARD};margin-bottom:14px">
        <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:6px">Recent bricks</div>
        ${recentRows}
      </div>
      ${captionCard('Bricks train the legs to switch from cycling to running. The engine reduces the run-leg fatigue discount as you log more bricks, up to a 40% reduction at full adaptation. Even a veteran still fades, but less. Brick detection looks for a ride immediately followed (within 45 minutes) by a run.')}
    `,
  };
}

function pageOpenWater(s: SimulatorState): PageContent {
  const nowMs = Date.now();
  const lookbackMs = 26 * 7 * 24 * 3600 * 1000;
  type Swim = { dateISO: string; durMin: number };
  const swims: Swim[] = [];
  for (const wk of s.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const a of Object.values(wk.garminActuals)) {
      const type = (a?.activityType ?? '').toUpperCase();
      if (!type.includes('OPEN_WATER')) continue;
      if (!a.startTime) continue;
      const age = nowMs - Date.parse(a.startTime);
      if (age < 0 || age > lookbackMs) continue;
      swims.push({ dateISO: a.startTime, durMin: (a.durationSec ?? 0) / 60 });
    }
  }
  swims.sort((a, b) => Date.parse(b.dateISO) - Date.parse(a.dateISO));
  const recent = swims.slice(0, 5);
  const count = swims.length;

  const raceId = s.onboarding?.selectedTriathlonId;
  const race = raceId ? getTriathlonById(raceId) : null;
  const swimType = race?.profile?.swimType ?? '';
  const wetsuit = swimType.includes('wetsuit') || swimType === 'wetsuit-lake';
  // Base penalty: wetsuit ~2.5%, non-wetsuit ~6% (engine constants).
  const basePct = wetsuit ? 2.5 : 6.0;
  // Half-saturation around 8 sessions in the engine. Use that here.
  const adapt = 1 - Math.exp(-count / 8);
  const remainingPct = basePct * (1 - adapt);

  const headline = count === 0 ? 'No OW swims logged'
    : count <= 2 ? 'Light exposure'
    : count <= 6 ? 'Adapting'
    : 'Race-ready';

  const recentRows = recent.length === 0
    ? `<div style="font-size:13px;color:${TEXT_S};line-height:1.5;text-align:center;padding:6px 0">Tag a Strava OW swim or sync a Garmin open-water session to populate.</div>`
    : recent.map(sw => `
        <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.04)">
          <span style="color:${TEXT_M}">${new Date(sw.dateISO).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          <span style="color:${TEXT_M};font-variant-numeric:tabular-nums">${Math.round(sw.durMin)} min</span>
        </div>
      `).join('');

  return {
    title: 'Open water',
    subhead: 'Adaptation to race-day swim conditions',
    body: `
      <div style="${CARD};margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div>
            <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">${escapeText(headline)}</div>
            <div style="font-size:28px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${count} <span style="font-size:14px;color:${TEXT_S};font-weight:500">OW swims · 26w</span></div>
          </div>
          <div style="text-align:right;font-size:11px;color:${TEXT_L};line-height:1.5">
            Remaining swim penalty<br/>
            <span style="color:${TEXT_M};font-weight:600;font-size:14px">+${remainingPct.toFixed(1)}%</span><br/>
            (base ${basePct}% ${wetsuit ? 'wetsuit' : 'non-wetsuit'})
          </div>
        </div>
      </div>
      <div style="${CARD};margin-bottom:14px">
        <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:6px">Recent OW swims</div>
        ${recentRows}
      </div>
      ${captionCard('Open-water swims train sighting, chop tolerance, and pacing without walls. The engine reduces the OW penalty as you log more sessions, saturating around 8 swims. Wetsuit races carry a lower base penalty because buoyancy offsets some of the OW-vs-pool gap.')}
    `,
  };
}

function pageVenue(s: SimulatorState, p: TriRacePrediction | null): PageContent {
  const factors: CourseFactorEntry[] = p?.courseFactors ?? [];
  const raceId = s.onboarding?.selectedTriathlonId;
  const race = raceId ? getTriathlonById(raceId) : null;
  const raceName = race?.name ?? 'No race selected';
  const profile = race?.profile;

  if (!race) {
    return {
      title: 'Venue',
      subhead: 'Course adjustments',
      body: `<div style="${CARD};text-align:center;margin-bottom:14px"><div style="font-size:14px;color:${TEXT_M};line-height:1.5;margin-bottom:6px">No race selected yet.</div><div style="font-size:12px;color:${TEXT_S}">Pick a target race on the Account page.</div></div>`,
    };
  }

  if (factors.length === 0) {
    return {
      title: 'Venue',
      subhead: raceName,
      body: `<div style="${CARD};margin-bottom:14px"><div style="font-size:14px;color:${TEXT_M};line-height:1.5">No course adjustments applied. The venue is treated as flat and cool until factors land.</div></div>`,
    };
  }

  const legOrder: Array<'swim' | 'bike' | 'run'> = ['swim', 'bike', 'run'];
  const legAgg = legOrder
    .map(leg => {
      const rows = factors.filter(f => f.leg === leg);
      if (rows.length === 0) return null;
      const totalDelta = rows.reduce((sum, f) => sum + f.deltaSec, 0);
      return { leg, totalDelta, rows };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const totalDelta = legAgg.reduce((sum, x) => sum + x.totalDelta, 0);
  const adjustedSec = p?.totalSec ?? 0;
  const rawSec = adjustedSec - totalDelta;
  const compoundedMult = rawSec > 0 ? adjustedSec / rawSec : 1;
  const totalPct = (compoundedMult - 1) * 100;
  const totalSign = totalPct >= 0 ? '+' : '−';
  const slowerOrFaster = totalPct >= 0 ? 'slower' : 'faster';

  const headlineCard = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
        <div>
          <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">${escapeText(raceName)}</div>
          <div style="font-size:24px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em">${totalSign}${Math.abs(totalPct).toFixed(1)}% ${slowerOrFaster}</div>
          <div style="font-size:12px;color:${TEXT_S};margin-top:4px">vs an ideal flat, cool, sea-level course (not this venue)</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:${TEXT_L};margin-bottom:2px">Net cost</div>
          <div style="font-size:18px;color:${TEXT_M};font-variant-numeric:tabular-nums">${totalDelta >= 0 ? '+' : '−'}${fmtDuration(Math.abs(totalDelta))}</div>
        </div>
      </div>
    </div>
  `;

  const maxAbsPct = Math.max(...factors.map(f => Math.abs((f.multiplier - 1) * 100)), 0.5);
  const factorBars = legAgg.map(({ leg, totalDelta: legDelta, rows }) => {
    const accent = leg === 'swim' ? COL_SWIM : leg === 'bike' ? COL_BIKE : COL_RUN;
    const legPct = (rows.reduce((m, r) => m * r.multiplier, 1) - 1) * 100;
    const legSign = legPct >= 0 ? '+' : '−';
    const legHeader = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:10px 0 6px;font-size:13px">
        <span style="display:flex;align-items:center;gap:8px;color:${TEXT_M};font-weight:600">
          ${disciplineDot(accent)}${leg.charAt(0).toUpperCase() + leg.slice(1)}
        </span>
        <span style="color:${legPct >= 0 ? '#9A6A20' : '#1F7A3D'};font-variant-numeric:tabular-nums">${legSign}${Math.abs(legPct).toFixed(1)}% (${legSign}${fmtDuration(Math.abs(legDelta))})</span>
      </div>
    `;
    const factorRows = rows.map(f => {
      const pct = (f.multiplier - 1) * 100;
      const sign = pct >= 0 ? '+' : '−';
      const widthPct = (Math.abs(pct) / maxAbsPct) * 100;
      const tone = pct >= 0 ? '#C48A3A' : '#5a8050';
      const toneFill = pct >= 0 ? 'rgba(196,138,58,0.18)' : 'rgba(90,128,80,0.18)';
      return `
        <div style="padding:8px 0 10px;border-top:1px solid rgba(0,0,0,0.04)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <div>
              <span style="font-size:12px;color:${TEXT_M}">${escapeText(f.label)}</span>
              <span style="font-size:11px;color:${TEXT_S};margin-left:6px">${escapeText(f.value)}</span>
            </div>
            <span style="font-size:12px;color:${tone};font-variant-numeric:tabular-nums">${sign}${Math.abs(pct).toFixed(1)}%</span>
          </div>
          <div style="position:relative;height:5px;border-radius:3px;background:${toneFill};overflow:hidden">
            <div style="position:absolute;left:0;top:0;height:100%;width:${widthPct.toFixed(1)}%;background:${tone};border-radius:3px"></div>
          </div>
        </div>
      `;
    }).join('');
    return `${legHeader}${factorRows}`;
  }).join('');

  const altitudeM = profile?.altitudeM ?? 0;
  const altitudeNote = altitudeM >= 800 ? `<div style="${CARD};margin-bottom:14px"><div style="font-size:12px;color:${TEXT_S};line-height:1.55">Race altitude is ${altitudeM} m. The penalty depends on your acclimatisation, which we don't track directly. Sea-level athletes may run slower than the factor suggests.</div></div>` : '';

  const isEmpirical = factors.length > 0 && /n=\d+/.test(factors[0].value);
  const nMatch = isEmpirical ? factors[0]?.value.match(/n=(\d+)/) : null;
  const venueN = nMatch ? Number(nMatch[1]) : null;
  const sourceCaption = isEmpirical
    ? `Calibrated against 1.3 million historical Ironman and 70.3 race finishes (CoachCox, Kaggle, 2002 to 2024). ${venueN ? `${venueN.toLocaleString()} finishes from this venue.` : ''}`
    : 'Course factors use the physical model. The empirical dataset does not yet cover this venue or has too few finishers for a reliable fit.';

  return {
    title: 'Venue',
    subhead: `${raceName} course adjustments`,
    body: `
      ${headlineCard}
      <div style="${CARD};margin-bottom:14px">
        <div style="font-size:14px;color:${TEXT_S};font-weight:500;margin-bottom:4px">Factor breakdown</div>
        ${factorBars}
      </div>
      ${altitudeNote}
      ${captionCard(sourceCaption)}
    `,
  };
}

function pageTransitions(s: SimulatorState, p: TriRacePrediction | null): PageContent {
  if (!p) {
    return {
      title: 'Transitions',
      subhead: 'T1 and T2',
      body: `<div style="${CARD};text-align:center"><div style="font-size:14px;color:${TEXT_M};line-height:1.5">Markers needed before transitions can be predicted.</div></div>`,
    };
  }
  const tri = s.triConfig;
  const override = tri?.transitionOverride;
  const usingOverride = override?.t1Sec != null && override?.t2Sec != null;
  const sockChoice = tri?.transitionSocks ?? 't1';
  const sockLabel = sockChoice === 't1' ? 'Socks on at T1 (keep for run)'
    : sockChoice === 't2' ? 'Sockless bike, socks on at T2'
    : 'Sockless (no socks at all)';

  const meta = p.transitionMeta;
  const raceId = s.onboarding?.selectedTriathlonId;
  const race = raceId ? getTriathlonById(raceId) : null;
  const raceName = race?.name ?? 'this race';
  const movingSec = p.swimSec + p.bikeSec + p.runSec;
  const fmtHM = (sec: number): string => {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
  };
  const sourceLabel = meta?.source === 'race-empirical' ? 'Historical field average'
    : meta?.source === 'global-empirical' ? 'Field average'
    : meta?.source === 'user-override' ? 'Your benchmark'
    : 'Skill estimate';

  const headlineCard = `
    <div style="${CARD};margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
        <div>
          <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Total transitions</div>
          <div style="font-size:28px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${fmtDuration(p.t1Sec + p.t2Sec)}</div>
        </div>
        <div style="text-align:right;font-size:11px;color:${TEXT_L};line-height:1.5">${sourceLabel}</div>
      </div>
      ${statRow('T1 (swim → bike)', fmtMSS(p.t1Sec))}
      ${statRow('T2 (bike → run)',  fmtMSS(p.t2Sec))}
      ${statRow('Sock choice', sockLabel)}
    </div>
    <button id="tri-fcd-transitions-open" style="display:block;width:100%;margin-bottom:14px;padding:13px;border-radius:100px;border:1px solid var(--c-border);background:transparent;color:${TEXT_M};font:inherit;font-size:13px;font-weight:600;cursor:pointer">Adjust T1 / T2 →</button>
  `;

  // Field-context card: tell the user why the number is what it is. The same
  // empirical band that produced their T1/T2 also gives the population mean and
  // the speed gradient, so the comparison never contradicts the headline.
  let contextCard = '';
  const isEmpirical = meta?.source === 'race-empirical' || meta?.source === 'global-empirical';
  if (isEmpirical && meta?.fieldMeanSec != null) {
    const provenance = meta.source === 'race-empirical' && meta.venueFinishers
      ? `Based on ${meta.venueFinishers.toLocaleString()} finishers at ${escapeText(raceName)}${meta.sampleN ? `, ${meta.sampleN.toLocaleString()} near your swim-bike-run time` : ''}.`
      : `We do not have enough finishers at ${escapeText(raceName)} to calibrate it directly, so this is the global field average across ${(meta.datasetFinishers ?? 0).toLocaleString()} finishes at your distance. Transition times vary widely by venue, from the size of the transition zone to the run in from the swim exit, so treat this as a baseline.`;
    const benchmarkLine = usingOverride
      ? 'You have set your own benchmark, so the prediction uses it instead of the field.'
      : 'You have not set your own benchmark, so the prediction uses this field average.';
    contextCard = `
      <div style="${CARD};margin-bottom:14px">
        <div style="font-size:14px;color:${TEXT_M};line-height:1.5;font-weight:500;margin-bottom:4px">Finishers around your swim-bike-run time (≈${fmtHM(movingSec)}) average ${fmtMSS(meta.fieldMeanSec)} in transitions.</div>
        <div style="font-size:13px;color:${TEXT_S};line-height:1.55;margin-bottom:6px">${provenance} ${benchmarkLine}</div>
        ${statRow('Field average (T1 + T2)', fmtMSS(meta.fieldMeanSec))}
        ${statRow('Your estimate', fmtMSS(p.t1Sec + p.t2Sec))}
      </div>
    `;
  } else if (meta?.source === 'user-override') {
    const ref = meta.fieldMeanSec != null
      ? ` For reference, finishers around your swim-bike-run time average ${fmtMSS(meta.fieldMeanSec)}.`
      : '';
    contextCard = `
      <div style="${CARD};margin-bottom:14px">
        <div style="font-size:13px;color:${TEXT_S};line-height:1.55">You have set your own transition benchmark, so the prediction uses it directly.${ref}</div>
      </div>
    `;
  } else {
    contextCard = `
      <div style="${CARD};margin-bottom:14px">
        <div style="font-size:13px;color:${TEXT_S};line-height:1.55">No historical transition data covers ${escapeText(raceName)} yet, so this estimate comes from your skill rating. Transition times also vary widely by venue, from the size of the transition zone to the run in from the swim exit. Set your own benchmark for a sharper number.</div>
      </div>
    `;
  }

  return {
    title: 'Transitions',
    subhead: 'T1 and T2 clock time',
    body: `
      ${headlineCard}
      ${contextCard}
      ${captionCard('Transitions are added directly to the finish time. No multiplier. Default values come from 1.3 million historical Ironman and 70.3 finishes at your predicted swim-bike-run time. Transition times vary widely by venue, so where we have no data for your race this falls back to the global average at your distance. T1 runs longer than T2 because of the wetsuit strip and the longer run in from the swim exit. You can override with your own benchmark. Sock choice shifts the ~20 s sock-on cost between T1 and T2, or removes it entirely if you go sockless.')}
    `,
  };
}

function pageHeat(s: SimulatorState): PageContent {
  const raceId = s.onboarding?.selectedTriathlonId;
  const race = raceId ? getTriathlonById(raceId) : null;
  const climate = race?.profile?.climate;
  const raceTemp = climate ? CLIMATE_ANCHOR_TEMP_C[climate] : null;

  // Same training-temp computation as the engine.
  const nowMs = Date.now();
  const lookbackMs = 4 * 7 * 24 * 3600 * 1000;
  const temps: number[] = [];
  for (const wk of s.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const a of Object.values(wk.garminActuals)) {
      if (a?.ambientTempC == null || !a.startTime) continue;
      if (nowMs - Date.parse(a.startTime) > lookbackMs) continue;
      temps.push(a.ambientTempC);
    }
  }
  const trainTemp = temps.length >= 4
    ? temps.reduce((a, b) => a + b, 0) / temps.length
    : null;

  const gap = trainTemp != null && raceTemp != null ? raceTemp - trainTemp : null;
  const headline = gap == null ? 'Cannot compare yet'
    : gap <= 0 ? 'Acclimated'
    : gap <= 5 ? 'Partially acclimated'
    : 'Cool training base';

  return {
    title: 'Heat',
    subhead: 'Training temperature vs race climate',
    body: `
      <div style="${CARD};margin-bottom:14px">
        <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">${escapeText(headline)}</div>
        <div style="font-size:24px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em">${gap != null ? `${gap >= 0 ? '+' : ''}${gap.toFixed(0)}°C gap` : '—'}</div>
        ${statRow('Race climate', climate ? `${climate} (~${Math.round(raceTemp!)}°C anchor)` : '—')}
        ${statRow('Recent training avg', trainTemp != null ? `${trainTemp.toFixed(1)}°C (${temps.length} activities)` : 'Not enough outdoor data')}
      </div>
      ${captionCard('Athletes who train in heat similar to the race climate retain 3 to 5 percent performance compared to athletes who train cool. The engine discounts the physical climate penalty up to 50 percent when training temperature is within 15°C of the race anchor. And zero when the gap is larger. Swim is unaffected (water cooling).')}
    `,
  };
}

function pageMarathonDepth(s: SimulatorState): PageContent {
  const pb = s.pbs?.m ?? 0;
  const onsetSec = 4.5 * 3600;
  const maxSec   = 2.75 * 3600;

  const credit = pb === 0 ? 0
    : pb >= onsetSec ? 0
    : Math.min(1, (onsetSec - pb) / (onsetSec - maxSec)) * 4; // up to 4% credit
  const headline = pb === 0 ? 'No marathon PB'
    : credit === 0 ? 'No credit'
    : `${credit.toFixed(1)}% IM run credit`;

  const pbDateISO = s.onboarding?.pbDates?.m;
  let recencyLabel = '';
  if (pbDateISO) {
    // The model's own weight (pbAgeWeight, the weight
    // computeMarathonDepthMultiplier applies), so the label cannot drift.
    const years = pbAgeYears(pbDateISO);
    const weight = pbAgeWeight(pbDateISO);
    const when = years == null || years < 1 ? 'Under a year ago' : `${years.toFixed(1)} years ago`;
    const weighting = weight >= 1 ? 'full credit weighting' : `${Math.round(weight * 100)}% credit weighting`;
    recencyLabel = `${when} (${weighting})`;
  }

  return {
    title: 'Marathon depth',
    subhead: 'Ironman run-leg credit',
    body: `
      <div style="${CARD};margin-bottom:14px">
        <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">${escapeText(headline)}</div>
        <div style="font-size:28px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${pb > 0 ? fmtDuration(pb) : '—'}</div>
        ${pbDateISO ? statRow('PB recency', recencyLabel) : ''}
        ${statRow('Credit window', '2:45 (full) → 4:30 (none)')}
      </div>
      ${captionCard('A fast marathoner running the Ironman marathon (85% of marathon intensity) has headroom to maintain form through the back half. The engine applies up to a 4 percent pace credit on the IM run leg for sub-2:45 marathoners, scaling down to zero at a 4:30 marathon PB. Recent PBs carry more weight than old ones.')}
    `,
  };
}

function pageCalibration(s: SimulatorState): PageContent {
  const cal = s.triConfig?.calibration;
  if (!cal || cal.tier < 1) {
    return {
      title: 'Calibration',
      subhead: 'Per-user prediction adjustment',
      body: `<div style="${CARD};text-align:center"><div style="font-size:14px;color:${TEXT_M};line-height:1.5">Calibration activates once you have logged at least 2 races.</div></div>`,
    };
  }
  const n = cal.basedOnRaceCount;
  const bias = cal.perLegBiasSec;

  return {
    title: 'Calibration',
    subhead: `Tier ${cal.tier} learning from your races`,
    body: `
      <div style="${CARD};margin-bottom:14px">
        <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Calibration active</div>
        <div style="font-size:28px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">Tier ${cal.tier} <span style="font-size:13px;color:${TEXT_S};font-weight:500">· ${n} race${n === 1 ? '' : 's'}</span></div>
        ${bias ? `
          ${statRow('Swim bias', `${bias.swim >= 0 ? '+' : ''}${Math.round(bias.swim)} s`)}
          ${statRow('Bike bias', `${bias.bike >= 0 ? '+' : ''}${Math.round(bias.bike)} s`)}
          ${statRow('Run bias',  `${bias.run  >= 0 ? '+' : ''}${Math.round(bias.run)} s`)}
        ` : ''}
      </div>
      ${captionCard('Calibration learns the systematic difference between your predicted leg times and what you actually do on race day. A positive bias means you tend to be slower than the model predicts; the model adds the bias back into future predictions. Capped at ±8% of median leg time so a single outlier race cannot skew the prediction.')}
    `,
  };
}

// ── Page selector ────────────────────────────────────────────────────────────

function pageFor(key: TriChipKey, s: SimulatorState, p: TriRacePrediction | null): PageContent {
  switch (key) {
    case 'you':         return pageYou(s);
    case 'capacity':    return pageCapacity(s, p);
    case 'adaptation':  return pageAdaptation(s, p);
    case 'training':    return pageTraining(s, p);
    case 'endurance':   return pageEndurance(s, p);
    case 'durability':  return pageDurability(s, p);
    case 'bricks':      return pageBricks(s);
    case 'openwater':   return pageOpenWater(s);
    case 'venue':       return pageVenue(s, p);
    case 'transitions': return pageTransitions(s, p);
    case 'heat':        return pageHeat(s);
    case 'marathon':    return pageMarathonDepth(s);
    case 'calibration': return pageCalibration(s);
    // 'bike-setup' is intercepted in wireTriForecastChips and routed to the
    // bike-setup overlay; it never reaches this detail view, but the union
    // makes TS demand an exhaustive switch.
    case 'bike-setup':  return { title: 'Bike & aero', subhead: '', body: '' };
  }
}

// ── Public render ────────────────────────────────────────────────────────────

/**
 * Optional navigation context. When the detail page is opened from a host that
 * is NOT the live Forecast tab (e.g. the onboarding tri-plan-forecast step),
 * pass `onBack` to override the "← Back" target and `showTabBar:false` to drop
 * the bottom tab bar (the wizard has no tabs). Defaults preserve the live-app
 * behaviour (back → Forecast tab, tab bar shown).
 */
export interface TriDetailNavOpts {
  onBack?: () => void;
  showTabBar?: boolean;
}

export function renderTriForecastChipDetail(key: TriChipKey, opts?: TriDetailNavOpts): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const showTabBar = opts?.showTabBar !== false;
  const s = getState();
  const p = s.triConfig?.prediction ?? predictTriathlonRace(s);
  const page = pageFor(key, s, p);

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  container.innerHTML = `
    <style>
      @keyframes triFcdFloatUp { from { opacity:0; } to { opacity:1; } }
      .tri-fcd-fade { opacity:0; animation:triFcdFloatUp 0.55s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="tri-fcd-view" class="safe-top-bleed" data-chip="${key}" style="
      position:relative;min-height:100vh;background:${atmosphereGradient('sky')};
      font-family:var(--f);overflow-x:hidden;
    ">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('tri-fcd', { variant: 'whisper', palette: 'sky' })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <div class="tri-fcd-fade" style="animation-delay:0.02s;padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <button id="tri-fcd-back-btn" style="background:transparent;border:none;font-size:14px;color:${TEXT_S};cursor:pointer;padding:0;font-family:var(--f)">← Back</button>
          ${showTabBar ? `<button id="tri-fcd-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>` : ''}
        </div>

        <div class="tri-fcd-fade" style="animation-delay:0.06s;text-align:center;padding:20px 20px 16px">
          <div style="font-size:11px;color:${TEXT_S};font-weight:500">Forecast factor</div>
          <div style="font-size:30px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;line-height:1.1;margin-top:6px">${escapeText(page.title)}</div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">${escapeText(page.subhead)}</div>
        </div>

        <div class="tri-fcd-fade" style="animation-delay:0.12s;padding:0 16px">
          ${page.body}
        </div>

      </div>

      ${showTabBar ? renderTabBar('forecast') : ''}
    </div>
  `;

  const fcdView = document.getElementById('tri-fcd-view');
  if (fcdView) mountInfoPopovers(fcdView);

  document.getElementById('tri-fcd-back-btn')?.addEventListener('click', () => {
    if (opts?.onBack) { opts.onBack(); return; }
    import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
  });
  document.getElementById('tri-fcd-account-btn')?.addEventListener('click', () => {
    import('../account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Transitions drill-down: tap "Adjust" to open the existing slider overlay.
  document.getElementById('tri-fcd-transitions-open')?.addEventListener('click', async () => {
    const [{ openTransitionsOverlay }, { predictTriathlonRace }] = await Promise.all([
      import('./transitions-overlay'),
      import('@/calculations/race-prediction.triathlon'),
    ]);
    const sv = getState();
    const live = sv.triConfig?.prediction ?? predictTriathlonRace(sv);
    if (live) openTransitionsOverlay(live, () => renderTriForecastChipDetail('transitions', opts));
  });

  if (showTabBar) wireTabBarHandlers(navigateTab);

  // Silence unused-import warnings for utilities only used by some pages.
  void ft; void fp; void getMutableState; void saveState;
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('../home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('../main-view').then(m => m.renderMainView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderTriathlonStatsView());
  else if (tab === 'forecast') import('./forecast-view').then(m => m.renderTriathlonForecastView());
  else if (tab === 'account') import('../account-view').then(m => m.renderAccountView());
}
