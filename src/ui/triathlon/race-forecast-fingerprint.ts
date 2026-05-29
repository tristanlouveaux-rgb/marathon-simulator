/**
 * Triathlon race forecast fingerprint. Chip set that maps 1:1 to inputs of
 * `predictTriathlonRace`. Each chip surfaces one real math factor; missing
 * data is called out via the "Missing: …" line beneath the grid.
 *
 * Always-on chips (every chip always feeds the math, even when the value is
 * a default):
 *   You. PB blend anchor + post-race calibration bias
 *   Capacity. Current CSS · FTP · VDOT (projection in drill-down)
 *   Adaptation. Per-discipline ratios from 5 signals
 *   Training. Planned sessions + hours per discipline
 *   Readiness. Per-discipline endurance scores (replaces the standalone card above)
 *   Durability. Long-ride / long-run vs threshold → run-leg cap
 *   Bricks. Brick adaptation → reduces run-leg fatigue discount
 *   Open water. OW adaptation → reduces swim OW penalty
 *   Venue. Empirical / physical course factors per leg
 *   Transitions. T1/T2 clock-time addition
 *
 * Conditional chips (only render when the factor is actively contributing):
 *   Heat. Race climate is warm/hot/hot-humid
 *   Marathon. IM only AND a marathon PB is logged
 *   Calibration. ≥2 races logged
 *
 * Tap a chip → `renderTriForecastChipDetail()` in `forecast-chip-detail-view.ts`.
 */

import type { SimulatorState } from '@/types/state';
import type { TriRacePrediction } from '@/types/triathlon';
import { plannedSessionsPerWeekByDiscipline, longestSessionByDiscipline } from '@/calculations/tri-volume-by-discipline';
import { getTriathlonById } from '@/data/triathlons';
import { DURABILITY_THRESHOLDS } from '@/calculations/durability-cap';
import { CLIMATE_ANCHOR_TEMP_C } from '@/constants/triathlon-course-factors';

export type TriChipKey =
  | 'you' | 'capacity' | 'adaptation' | 'training' | 'endurance'
  | 'durability' | 'bricks' | 'openwater' | 'venue' | 'transitions'
  | 'bike-setup'
  | 'heat' | 'marathon' | 'calibration';

interface TriChip {
  key: TriChipKey;
  label: string;
  headline: string;
  detail: string;
  present: boolean;
  addCta?: string;
  /** Subtle dashboard-style headline tint. 'good' = muted moss, 'warn' = muted
   * clay. Only set when the headline carries a genuinely good/bad signal —
   * absence of data is NOT warn (it's already faded via !present). Two muted
   * non-neutrals only, text-only, no surface changes. */
  tone?: 'good' | 'warn';
}

// Muted dashboard tints. Soft enough not to fight the glass; saturated enough
// to read as a status at a glance. Black stays the default for everything else.
const TONE_COLOR: Record<NonNullable<TriChip['tone']>, string> = {
  good: '#4F7A4F',  // muted moss
  warn: '#A66F3E',  // muted clay
};

// ── Chip builders. One per math factor ──────────────────────────────────────

function buildYou(s: SimulatorState): TriChip {
  const tri = s.triConfig;
  const tier = s.athleteTier;
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1).replace('_', '-') : null;
  const headline = tierLabel ?? (s.typ ?? 'Triathlete');

  const runPbs = s.pbs ?? {};
  const swimPbs = tri?.swim?.pbs ?? {};
  const hasRunPb = Object.values(runPbs).some(v => typeof v === 'number' && v > 0);
  const hasSwimPb = Object.values(swimPbs).some(v => typeof v === 'number' && v > 0);
  const hasFtp = (tri?.bike?.ftp ?? 0) > 0;
  const hasCss = (tri?.swim?.cssSecPer100m ?? 0) > 0;
  const raceCount = tri?.raceLog?.length ?? 0;

  if (!tier && !hasRunPb && !hasSwimPb && !hasFtp && !hasCss && raceCount === 0) {
    return { key: 'you', label: 'You', headline, detail: 'Profile thin', present: false, addCta: 'Add PBs' };
  }

  const parts: string[] = [];
  if (raceCount > 0) parts.push(`${raceCount} race${raceCount === 1 ? '' : 's'}`);
  else if (hasRunPb || hasSwimPb) parts.push('PBs on file');
  else if (hasFtp || hasCss) parts.push('Markers set');

  return { key: 'you', label: 'You', headline, detail: parts.join(' · ') || 'Triathlete', present: true };
}

function buildCapacity(s: SimulatorState, p: TriRacePrediction | null): TriChip {
  const tri = s.triConfig;
  const css = tri?.swim?.cssSecPer100m;
  const ftp = tri?.bike?.ftp;
  const vdot = p?.projection?.runVdot?.current ?? s.v;

  const haveCss = typeof css === 'number' && css > 0;
  const haveFtp = typeof ftp === 'number' && ftp > 0;
  const haveVdot = typeof vdot === 'number' && vdot > 0;

  if (!haveCss && !haveFtp && !haveVdot) {
    return { key: 'capacity', label: 'Capacity', headline: 'No data', detail: '', present: false, addCta: 'Set markers' };
  }

  const parts: string[] = [];
  if (haveCss) parts.push(fmtCss(css!));
  if (haveFtp) parts.push(`${Math.round(ftp!)}W`);
  if (haveVdot) parts.push(`VDOT ${vdot!.toFixed(0)}`);
  const headline = parts.join(' · ');

  const weeksRemaining = p?.projection?.weeksRemaining ?? 0;
  const detail = weeksRemaining > 0
    ? `Race in ${Math.max(1, Math.round(weeksRemaining))}w`
    : 'Current markers';

  return { key: 'capacity', label: 'Capacity', headline, detail, present: true };
}

function buildAdaptation(_s: SimulatorState, p: TriRacePrediction | null): TriChip {
  const adaptation = p?.adaptation;
  if (!adaptation) {
    return {
      key: 'adaptation', label: 'Adaptation',
      headline: 'Building signal',
      detail: 'Log a few sessions',
      present: false,
      addCta: 'Sync activity',
    };
  }
  const sig = adaptation.signals;
  const populatedCount =
    (sig.hrv != null ? 1 : 0) +
    (sig.rpeSwim != null || sig.rpeBike != null || sig.rpeRun != null ? 1 : 0) +
    (sig.hrAtPower != null ? 1 : 0) +
    (sig.pahrBike != null || sig.pahrRun != null ? 1 : 0) +
    (sig.cssSd != null ? 1 : 0);

  if (populatedCount < 2) {
    return {
      key: 'adaptation', label: 'Adaptation',
      headline: 'Building signal',
      detail: `${populatedCount} of 5 signals`,
      present: false,
    };
  }

  const overallAvg = (adaptation.swim + adaptation.bike + adaptation.run) / 3;
  const headline = overallAvg >= 1.05 ? 'Ahead'
    : overallAvg <= 0.95 ? 'Behind'
    : 'On track';
  const tone: TriChip['tone'] = headline === 'Ahead' ? 'good'
    : headline === 'Behind' ? 'warn'
    : undefined;

  return {
    key: 'adaptation', label: 'Adaptation',
    headline,
    detail: `${populatedCount} of 5 signals`,
    present: true,
    tone,
  };
}

function buildTraining(s: SimulatorState): TriChip {
  const planned = plannedSessionsPerWeekByDiscipline(s, 4);
  const total = planned.swim + planned.bike + planned.run;

  if (total <= 0) {
    return { key: 'training', label: 'Training', headline: 'Not started', detail: '', present: false, addCta: 'Generate plan' };
  }

  const headline = `${total.toFixed(1).replace(/\.0$/, '')} sess/wk`;
  const detail = `S ${planned.swim.toFixed(1).replace(/\.0$/, '')} · B ${planned.bike.toFixed(1).replace(/\.0$/, '')} · R ${planned.run.toFixed(1).replace(/\.0$/, '')}`;

  return { key: 'training', label: 'Training', headline, detail, present: true };
}

function buildEndurance(_s: SimulatorState, p: TriRacePrediction | null): TriChip {
  const r = p?.raceReadiness;
  if (!r) {
    return { key: 'endurance', label: 'Endurance', headline: 'Pending', detail: 'Needs markers', present: false };
  }
  const overall = Math.round(r.overallScore);
  const detail = `S ${Math.round(r.swim.score)} · B ${Math.round(r.bike.score)} · R ${Math.round(r.run.score)}`;
  // Score thresholds match the existing readiness-label bands so the tint
  // tracks the qualitative label without re-deriving it.
  const tone: TriChip['tone'] = overall >= 75 ? 'good'
    : overall < 55 ? 'warn'
    : undefined;
  return {
    key: 'endurance', label: 'Endurance',
    headline: `${overall} · ${r.overallLabel}`,
    detail,
    present: true,
    tone,
  };
}

function buildDurability(s: SimulatorState, p: TriRacePrediction | null): TriChip {
  if (!p) {
    return { key: 'durability', label: 'Durability', headline: 'Pending', detail: 'Needs markers', present: false };
  }
  const longest = longestSessionByDiscipline(s, 12);
  const distance = s.triConfig?.distance ?? '70.3';
  const rideTh = DURABILITY_THRESHOLDS[distance].longRideSec;
  const runTh  = DURABILITY_THRESHOLDS[distance].longRunSec;
  const bikePct = rideTh > 0 ? Math.min(100, (longest.bike / rideTh) * 100) : 0;
  const runPct  = runTh  > 0 ? Math.min(100, (longest.run  / runTh)  * 100) : 0;

  const capped = !!p.limitingFactor;
  const headline = capped ? 'Capped'
    : bikePct >= 100 && runPct >= 100 ? 'Met'
    : 'Building';
  const detail = `Bike ${Math.round(bikePct)}% · Run ${Math.round(runPct)}%`;
  const tone: TriChip['tone'] = headline === 'Met' ? 'good'
    : headline === 'Capped' ? 'warn'
    : undefined;

  return {
    key: 'durability', label: 'Durability',
    headline,
    detail,
    present: bikePct > 0 || runPct > 0,
    addCta: bikePct === 0 && runPct === 0 ? 'Log a long session' : undefined,
    tone,
  };
}

function buildBricks(s: SimulatorState): TriChip {
  // Lightweight count of recent brick-shape activities (bike → run within ~30 min).
  // The full computeBrickAdaptation runs in race-prediction; here we just expose
  // the *count* signal so the chip headline matches drill-down content.
  const wks = s.wks ?? [];
  let count = 0;
  for (const wk of wks) {
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
      if (gapMin >= 0 && gapMin <= 45) count += 1;
    }
  }

  const headline = count === 0 ? 'No bricks'
    : count <= 3 ? 'Building'
    : count <= 10 ? 'Adapting'
    : 'Adapted';
  const detail = count > 0 ? `${count} bricks logged` : 'Reduces run fade';
  // Only 'Adapted' earns the good tint. 'Building' / 'Adapting' / 'No bricks'
  // are honest in-progress states; leaving them neutral keeps the chip from
  // celebrating partial work.
  const tone: TriChip['tone'] = headline === 'Adapted' ? 'good' : undefined;

  return {
    key: 'bricks', label: 'Bricks',
    headline,
    detail,
    present: count > 0,
    addCta: count === 0 ? 'Log a brick' : undefined,
    tone,
  };
}

function buildOpenWater(s: SimulatorState): TriChip {
  // Count OW swims in last 26w (matches engine lookback).
  const nowMs = Date.now();
  const lookbackMs = 26 * 7 * 24 * 3600 * 1000;
  let count = 0;
  for (const wk of s.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const a of Object.values(wk.garminActuals)) {
      const type = (a?.activityType ?? '').toUpperCase();
      if (!type.includes('OPEN_WATER')) continue;
      if (!a.startTime) continue;
      const age = nowMs - Date.parse(a.startTime);
      if (age >= 0 && age <= lookbackMs) count += 1;
    }
  }

  const raceId = s.onboarding?.selectedTriathlonId;
  const race = raceId ? getTriathlonById(raceId) : null;
  const swimType = race?.profile?.swimType ?? '';
  const wetsuit = swimType.includes('wetsuit') || swimType === 'wetsuit-lake';
  const swimTypeLabel = !race ? 'Race not picked'
    : wetsuit ? 'Wetsuit swim'
    : swimType ? swimType.replace(/-/g, ' ') : 'OW swim';

  const headline = count === 0 ? 'No OW swims'
    : count <= 2 ? 'Light exposure'
    : count <= 6 ? 'Adapting'
    : 'Race-ready';
  const detail = count > 0 ? `${count} swims · ${swimTypeLabel}` : swimTypeLabel;
  const tone: TriChip['tone'] = headline === 'Race-ready' ? 'good' : undefined;

  return {
    key: 'openwater', label: 'Open water',
    headline,
    detail,
    present: count > 0,
    tone,
    addCta: count === 0 ? 'Log an OW swim' : undefined,
  };
}

function buildVenue(s: SimulatorState, p: TriRacePrediction | null): TriChip {
  const raceId = s.onboarding?.selectedTriathlonId;
  const race = raceId ? getTriathlonById(raceId) : null;
  const raceLabel = race?.city ?? race?.name ?? null;

  const factors = p?.courseFactors ?? [];
  if (factors.length === 0) {
    return {
      key: 'venue', label: 'Venue',
      headline: raceLabel ? shortVenueName(raceLabel) : 'No race',
      detail: raceLabel ? 'Factors pending' : '',
      present: !!raceLabel,
      addCta: raceLabel ? undefined : 'Pick a race',
    };
  }

  const totalDeltaSec = factors.reduce((acc, f) => acc + f.deltaSec, 0);
  const baseTotalSec = (p?.totalSec ?? 1) - totalDeltaSec;
  const pct = baseTotalSec > 0 ? (totalDeltaSec / baseTotalSec) * 100 : 0;
  const sign = pct >= 0 ? '+' : '−';
  const detail = Math.abs(pct) < 0.5 ? 'vs flat baseline' : `${sign}${Math.abs(pct).toFixed(1)}% vs flat`;

  return {
    key: 'venue', label: 'Venue',
    headline: shortVenueName(raceLabel ?? 'Course'),
    detail,
    present: true,
  };
}

function buildTransitions(_s: SimulatorState, p: TriRacePrediction | null): TriChip {
  if (!p) {
    return { key: 'transitions', label: 'Transitions', headline: '—', detail: 'Needs markers', present: false };
  }
  const total = p.t1Sec + p.t2Sec;
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return {
    key: 'transitions', label: 'Transitions',
    headline: `${m}:${String(sec).padStart(2, '0')}`,
    detail: `T1 ${fmtMSS(p.t1Sec)} · T2 ${fmtMSS(p.t2Sec)}`,
    present: true,
  };
}

function buildBikeSetup(s: SimulatorState): TriChip {
  const profile = s.triConfig?.bike?.aeroProfiles?.[0];
  if (!profile) {
    return {
      key: 'bike-setup',
      label: 'Bike & aero',
      headline: 'Not set',
      detail: 'Default fit',
      present: false,
      addCta: 'Set up',
    };
  }
  const POSITION_LABEL: Record<typeof profile.position, string> = {
    'hoods':    'Hoods',
    'drops':    'Drops',
    'clip-ons': 'Clip-ons',
    'tt-bike':  'TT bike',
  };
  const headline = POSITION_LABEL[profile.position] ?? 'Custom';
  const calibrated = profile.cdaSource === 'calibrated';
  const detail = calibrated
    ? `Calibrated · CdA ${profile.cda.toFixed(2)}`
    : `CdA ${profile.cda.toFixed(2)} m²`;
  return { key: 'bike-setup', label: 'Bike & aero', headline, detail, present: true };
}

function buildHeat(s: SimulatorState, _p: TriRacePrediction | null): TriChip | null {
  const raceId = s.onboarding?.selectedTriathlonId;
  const race = raceId ? getTriathlonById(raceId) : null;
  const climate = race?.profile?.climate;
  if (climate !== 'warm' && climate !== 'hot' && climate !== 'hot-humid') return null;

  // Recent training temperature (last 4 weeks).
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
  const raceTemp = CLIMATE_ANCHOR_TEMP_C[climate];

  if (trainTemp == null) {
    return {
      key: 'heat', label: 'Heat',
      headline: 'Unknown',
      detail: `Race ~${Math.round(raceTemp)}°C`,
      present: false,
      addCta: 'Sync outdoor activity',
    };
  }

  const gap = raceTemp - trainTemp;
  const headline = gap <= 0 ? 'Acclimated'
    : gap <= 5 ? 'Partially'
    : 'Cool training';
  const detail = `Train ${Math.round(trainTemp)}°C · race ${Math.round(raceTemp)}°C`;

  return { key: 'heat', label: 'Heat', headline, detail, present: true };
}

function buildMarathonDepth(s: SimulatorState): TriChip | null {
  if (s.triConfig?.distance !== 'ironman') return null;
  const marathonPb = s.pbs?.m;
  if (!marathonPb || marathonPb <= 0) return null;

  // Mirror the engine's onset/max windows.
  const onsetSec = 4.5 * 3600;
  const maxSec   = 2.75 * 3600;
  const headline = marathonPb >= onsetSec ? 'No credit'
    : marathonPb <= maxSec ? 'Deep credit'
    : 'Some credit';

  const h = Math.floor(marathonPb / 3600);
  const m = Math.floor((marathonPb % 3600) / 60);
  const detail = `PB ${h}:${String(m).padStart(2, '0')} on the marathon`;
  return { key: 'marathon', label: 'Marathon', headline, detail, present: true };
}

function buildCalibration(s: SimulatorState): TriChip | null {
  const cal = s.triConfig?.calibration;
  if (!cal || cal.tier < 1) return null;
  const n = cal.basedOnRaceCount;
  const headline = `Tier ${cal.tier}`;
  const detail = `${n} race${n === 1 ? '' : 's'} learned`;
  return { key: 'calibration', label: 'Calibration', headline, detail, present: true };
}

// ── Public render ────────────────────────────────────────────────────────────

export function renderTriForecastFingerprint(
  s: SimulatorState,
  p: TriRacePrediction | null,
): string {
  const alwaysOn: TriChip[] = [
    buildYou(s),
    buildCapacity(s, p),
    buildAdaptation(s, p),
    buildTraining(s),
    buildEndurance(s, p),
    buildDurability(s, p),
    buildBricks(s),
    buildOpenWater(s),
    buildVenue(s, p),
    buildTransitions(s, p),
    buildBikeSetup(s),
  ];
  const conditional: TriChip[] = [
    buildHeat(s, p),
    buildMarathonDepth(s),
    buildCalibration(s),
  ].filter((c): c is TriChip => c !== null);

  const chips = [...alwaysOn, ...conditional];

  const chipHtml = chips.map(c => `
    <div class="tri-rfc-chip" data-cluster="${c.key}" role="button" tabindex="0" style="
      position:relative;
      min-width:0;
      background:linear-gradient(135deg,rgba(255,255,255,0.62) 0%,rgba(255,255,255,0.22) 100%);
      backdrop-filter:blur(20px) saturate(170%);-webkit-backdrop-filter:blur(20px) saturate(170%);
      border:1px solid rgba(255,255,255,${c.present ? 0.55 : 0.30});
      box-shadow:0 4px 12px rgba(0,0,0,0.08),inset 0 1px 0 rgba(255,255,255,0.6);
      border-radius:14px;padding:12px 8px;text-align:center;min-height:86px;
      display:flex;flex-direction:column;justify-content:center;cursor:pointer;
      -webkit-tap-highlight-color:transparent;
      transition:transform 0.15s cubic-bezier(0.2,0.8,0.2,1),box-shadow 0.15s;
    ">
      <div style="position:absolute;top:8px;right:8px;pointer-events:none"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--c-muted)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></div>
      <div style="font-size:9px;color:var(--c-muted);font-weight:500;line-height:1;margin-bottom:6px">${escapeText(c.label)}</div>
      <div style="font-size:12px;color:${c.present ? (c.tone ? TONE_COLOR[c.tone] : 'var(--c-black)') : 'var(--c-muted)'};font-weight:600;line-height:1.15;letter-spacing:-0.005em">${escapeText(c.headline)}</div>
      ${c.detail ? `<div style="font-size:9px;color:var(--c-faint);line-height:1.2;margin-top:4px">${escapeText(c.detail)}</div>` : ''}
      ${!c.present && c.addCta ? `<div style="font-size:8px;color:var(--c-faint);margin-top:5px;line-height:1.15;font-style:italic">${escapeText(c.addCta)}</div>` : ''}
    </div>
  `).join('');

  // "Missing" list lists chips that *should* fire but lack user data. Conditional
  // chips that don't apply at all (e.g. cool-climate race → no Heat chip) never
  // render and aren't part of the missing list.
  const missing = chips.filter(c => !c.present).map(c => c.label);
  const missingLine = missing.length > 0
    ? `<div style="font-size:11px;color:var(--c-faint);margin-top:10px;line-height:1.4;text-align:center">Missing: ${missing.join(', ')}. fewer factors means lower confidence.</div>`
    : '';

  return `
    <style>
      @keyframes triRfcChipFadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
      .tri-rfc-chip { opacity:0; animation:triRfcChipFadeIn 0.45s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .tri-rfc-chip:hover { transform:translateY(-1px); box-shadow:0 6px 16px rgba(0,0,0,0.10),inset 0 1px 0 rgba(255,255,255,0.7); }
      .tri-rfc-chip:active { transform:translateY(0); }
      .tri-rfc-chip:nth-child(1)  { animation-delay:0.20s; }
      .tri-rfc-chip:nth-child(2)  { animation-delay:0.24s; }
      .tri-rfc-chip:nth-child(3)  { animation-delay:0.28s; }
      .tri-rfc-chip:nth-child(4)  { animation-delay:0.32s; }
      .tri-rfc-chip:nth-child(5)  { animation-delay:0.36s; }
      .tri-rfc-chip:nth-child(6)  { animation-delay:0.40s; }
      .tri-rfc-chip:nth-child(7)  { animation-delay:0.44s; }
      .tri-rfc-chip:nth-child(8)  { animation-delay:0.48s; }
      .tri-rfc-chip:nth-child(9)  { animation-delay:0.52s; }
      .tri-rfc-chip:nth-child(10) { animation-delay:0.56s; }
      .tri-rfc-chip:nth-child(11) { animation-delay:0.60s; }
      .tri-rfc-chip:nth-child(12) { animation-delay:0.64s; }
      .tri-rfc-chip:nth-child(13) { animation-delay:0.68s; }
    </style>
    <div style="margin-top:22px">
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">${chipHtml}</div>
      ${missingLine}
    </div>
  `;
}

/**
 * Wire chip click + keyboard handlers. Loads the detail view module on tap.
 * Call after the fingerprint HTML lands in the DOM.
 */
export function wireTriForecastChips(): void {
  document.querySelectorAll<HTMLElement>('.tri-rfc-chip').forEach(el => {
    const open = () => {
      const key = el.dataset.cluster as TriChipKey | undefined;
      if (!key) return;
      if (key === 'bike-setup') {
        import('./bike-setup-view').then(m => m.openBikeSetupOverlay());
        return;
      }
      import('./forecast-chip-detail-view').then(m => m.renderTriForecastChipDetail(key));
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeText(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtCss(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const sec = Math.round(secPer100m % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtMSS(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function shortVenueName(name: string): string {
  return name
    .replace(/\s+IRONMAN(\s+70\.3)?$/i, '')
    .replace(/^IRONMAN(\s+70\.3)?\s+/i, '')
    .trim() || name;
}
